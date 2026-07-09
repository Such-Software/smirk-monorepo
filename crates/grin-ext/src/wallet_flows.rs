//! High-level orchestrators for Grin send + invoice flows.
//!
//! These compose the lower-level primitives (BIP32-derived blinds, Pedersen
//! commitments, bulletproofs, slate construction) into single functions
//! the wasm/JS layer can call with wallet-level inputs (extended private
//! key, list of unspent outputs, amount, etc.).
//!
//! Mirrors the legacy smirk-extension's TS orchestrators
//! (`createSendTransaction`, `signSlate`, `finalizeSlate`, plus the
//! invoice trio) but in Rust, taking advantage of our own slate-builder
//! primitives. The behavioral contract is the same; the cross-validation
//! tests in `tests/grin_wallet_compat.rs` verify byte-equality of the
//! key derivation against `grin_keychain` and the slate format against
//! `grin_wallet_libwallet`'s parser.

use crate::bulletproof::pedersen_commit;
use crate::keychain::{derive_blind, SwitchCommitmentType};
use crate::kernel::KernelFeatures;
use crate::recovery::create_recoverable_output;
use crate::schnorr::point_add;
use crate::slate::{
    add_input_commitment, add_output_commitment, SlateStateV4, SlateV4,
};
use crate::slate_builder::{
    receiver_finalize_i3, receiver_init_i1, receiver_round_s2, sender_finalize_s3,
    sender_init_s1, sender_round_i2, ReceiverContext, ReceiverFinalizeI3Params,
    ReceiverInitI1Params, ReceiverRoundParams, SenderContext, SenderFinalizeParams,
    SenderInitParams, SenderRoundI2Params,
};
use crate::transaction::{
    pubkey_to_commitment, slate_to_transaction_bytes, slate_to_transaction_json,
    BuildTransactionParams, TxInput, TxOutput,
};

/// A single unspent output the wallet is about to spend.
///
/// `path` is the BIP32 derivation path (4 levels of u32) that produced
/// the original output's commitment; the wallet re-derives the same
/// blinding factor here to sign. `commitment` is the on-chain Pedersen
/// commitment of that output — used as the input reference in the
/// slate's `coms` list.
#[derive(Debug, Clone)]
pub struct UnspentOutput {
    /// 4-level BIP32 path to the output's blinding factor.
    pub path: [u32; 4],
    /// Output amount in nanogrin.
    pub amount: u64,
    /// 33-byte Pedersen commitment as stored on chain.
    pub commitment: [u8; 33],
    /// True iff this is a coinbase output (different kernel features).
    pub is_coinbase: bool,
}

/// Information about the change output created by this transaction. The
/// caller persists this so the wallet can later spend the change output
/// (re-derives the same blinding factor from `path`).
#[derive(Debug, Clone)]
pub struct ChangeOutputInfo {
    pub path: [u32; 4],
    pub amount: u64,
    pub commitment: [u8; 33],
    /// Bulletproof bytes — required when reconstructing the slate at
    /// finalization (compact S1 strips outputs from the wire form).
    pub proof: Vec<u8>,
}

/// Inputs to [`create_send_transaction`].
#[derive(Debug, Clone)]
pub struct CreateSendTxParams {
    /// Wallet's 64-byte BIP32 root (secret_key || chain_code).
    /// Derived via the v3 / `useBip39=false` path (raw entropy →
    /// HMAC-SHA512 with `"IamVoldemort"`) — grin-wallet compatible.
    pub extended_private_key: [u8; 64],
    /// LEGACY: optional v1/v2 ext key (`useBip39=true` —
    /// PBKDF2-then-HMAC). When set, the orchestrator falls back to
    /// this key if v3 derivation produces an input commitment that
    /// doesn't match the on-chain value. Lets v0.3 spend outputs
    /// created by pre-2026-05 v0.2.x wallets that hadn't yet
    /// migrated to v3 derivation. Sunset 2026-11-15. See
    /// `seed::mnemonic_to_extended_private_key_legacy_bip39`.
    pub legacy_extended_private_key: Option<[u8; 64]>,
    /// All inputs we're spending. Already selected by the caller —
    /// orchestrator does not pick UTXOs (the caller has wallet-level
    /// context about which UTXOs to use, see legacy notes on greedy
    /// selection with fee iteration).
    pub inputs: Vec<UnspentOutput>,
    /// Amount sent to the recipient, in nanogrin.
    pub amount: u64,
    /// Fee paid to the network. Caller computes this from the byte-
    /// size estimator (legacy `calculateGrinFee(num_inputs,
    /// num_outputs, num_kernels)`).
    pub fee: u64,
    /// Plain / HeightLocked / NRD. Plain for everyday sends.
    pub kernel_features: KernelFeatures,
    /// 4-level BIP32 path for the change output, if any. Caller is
    /// responsible for allocating a fresh `nChild` index.
    pub change_path: [u32; 4],
    /// Kernel offset scalar — typically all-zero for COMPACT_SLATE_PURPOSE_SEND_INITIAL
    /// (the receiver computes the offset adjustment at S2). Pass
    /// `[0u8; 32]` unless you have a specific reason otherwise.
    pub kernel_offset: [u8; 32],
    /// Kernel-signing nonce. Must be fresh per-slate, must not be
    /// reused. Generate via [`crate::random_secret_nonce`].
    pub kernel_nonce: [u8; 32],
    /// Bulletproof rewind nonce for the change output. Lets the wallet
    /// later recover the change output's value via bulletproof rewind.
    /// Convention: derive from a stable wallet-level nonce.
    pub bp_rewind_nonce: [u8; 32],
    /// Bulletproof private nonce. Fresh per-output.
    pub bp_private_nonce: [u8; 32],
    /// Optional UUID for the slate; if `None`, freshly generated.
    pub slate_id: Option<String>,
}

/// Output of [`create_send_transaction`]. The slate carries the
/// sender's participant data + inputs + (optional) change output, ready
/// for slatepack-encoding and transmission to the receiver. The
/// [`SenderContext`] must be retained for the finalize step.
#[derive(Debug, Clone)]
pub struct CreateSendTxOutput {
    pub slate: SlateV4,
    pub context: SenderContext,
    pub change_output: Option<ChangeOutputInfo>,
    /// Per-input label of the derivation that successfully reproduced
    /// each input's commitment ("v3+Regular" / "legacy+Regular" /
    /// "v3+None" / "legacy+None"). Useful for diagnostics + telling
    /// users when their wallet is using the legacy fallback. Sunset
    /// 2026-11-15 alongside `mnemonic_to_extended_private_key_legacy_bip39`.
    pub input_derivations: Vec<String>,
}

/// Build the sender's S1 slate from wallet-level inputs.
///
/// 1. Derive each input's blinding factor (switch=Regular) and verify
///    its Pedersen commitment matches what the caller supplied.
///    Mismatch = wrong key/path/amount combination, hard error.
/// 2. If `inputs_total > amount + fee`, derive the change blind,
///    Pedersen-commit, and bulletproof the change value.
/// 3. Compute `sender_blind_excess = change_blind − Σ input_blinds −
///    kernel_offset` (or `0 − Σ input_blinds − kernel_offset` when no
///    change). This is the secret scalar whose public key the sender
///    contributes to the kernel signature.
/// 4. Call `sender_init_s1` to build the SlateV4 with the sender's
///    participant data (xs + nonce).
/// 5. Append input commitments to the slate's `coms` list. Append the
///    change output (commitment + bulletproof) if there is one.
/// 6. Return the slate + the sender context (retain for finalize).
pub fn create_send_transaction(
    params: &CreateSendTxParams,
) -> Result<CreateSendTxOutput, String> {
    if params.inputs.is_empty() {
        return Err("create_send_transaction: no inputs provided".into());
    }

    // 1. Derive input blinds and verify commitments.
    //    Tries v3 first; on commitment mismatch, falls back through
    //    a series of candidate derivations (legacy useBip39=true
    //    ext-key, switch=None, etc.) before giving up. Lets v0.3
    //    spend outputs created by pre-2026-05 wallets that used the
    //    legacy derivation, plus catches stale-DB n_child mismatches
    //    via diagnostic output. See `derive_input_blind_with_fallback`.
    let mut input_blinds = Vec::with_capacity(params.inputs.len());
    let mut input_derivations: Vec<String> = Vec::with_capacity(params.inputs.len());
    for input in &params.inputs {
        let (blind, label) = derive_input_blind_with_fallback(
            &params.extended_private_key,
            params.legacy_extended_private_key.as_ref(),
            input,
        )?;
        input_blinds.push(blind);
        input_derivations.push(label.to_string());
    }

    let inputs_total: u64 = params.inputs.iter().map(|i| i.amount).sum();
    let target = params.amount.checked_add(params.fee).ok_or_else(|| {
        "amount + fee overflows u64 — refuse to construct this slate".to_string()
    })?;
    if inputs_total < target {
        return Err(format!(
            "insufficient inputs: have {} nanogrin, need {} nanogrin (amount + fee)",
            inputs_total, target
        ));
    }
    let change_amount = inputs_total - target;

    // 2. Build change output (if any).
    let (sender_output_blinds, change_output) = if change_amount > 0 {
        let change_blind = derive_blind(
            &params.extended_private_key,
            &params.change_path,
            change_amount,
            SwitchCommitmentType::Regular,
        )?;
        // Seed-recoverable change output: deterministic view-key rewind
        // nonce + embedded identifier message (see create_recoverable_output).
        let (change_commit, change_proof, _) = create_recoverable_output(
            &params.extended_private_key,
            change_amount,
            &change_blind,
            &params.change_path,
            SwitchCommitmentType::Regular,
            &params.bp_private_nonce,
        )?;
        (
            vec![change_blind],
            Some(ChangeOutputInfo {
                path: params.change_path,
                amount: change_amount,
                commitment: change_commit,
                proof: change_proof,
            }),
        )
    } else {
        (Vec::new(), None)
    };

    // 3. Sender's blind excess scalar.
    let sender_blind_excess = crate::blind::sender_blind_excess(
        &input_blinds,
        &sender_output_blinds,
        &params.kernel_offset,
    );

    // 4. Build the S1 slate via the low-level slate-builder primitive.
    let init_params = SenderInitParams {
        amount: params.amount,
        fee: params.fee,
        kernel_features: params.kernel_features,
        sender_blind_excess,
        kernel_offset: params.kernel_offset,
        kernel_nonce: params.kernel_nonce,
    };
    let init_out = match &params.slate_id {
        Some(id) => crate::slate_builder::sender_init_s1_with_id(&init_params, id.clone())?,
        None => sender_init_s1(&init_params)?,
    };
    let mut slate = init_out.slate;

    // 5. Append input commitments + (optional) change output to coms.
    for input in &params.inputs {
        add_input_commitment(&mut slate, input.commitment, input.is_coinbase);
    }
    if let Some(change) = &change_output {
        add_output_commitment(&mut slate, change.commitment, change.proof.clone(), false);
    }

    Ok(CreateSendTxOutput {
        slate,
        context: init_out.context,
        change_output,
        input_derivations,
    })
}

// =============================================================================
// Sign incoming S1 slate (receiver side)
// =============================================================================

/// Info about the output the receiver creates by signing an incoming
/// send. Persisted so the wallet can later spend this output (path is
/// what re-derives the blinding factor).
#[derive(Debug, Clone)]
pub struct ReceiverOutputInfo {
    pub path: [u32; 4],
    pub amount: u64,
    pub commitment: [u8; 33],
    pub proof: Vec<u8>,
}

/// Inputs to [`sign_incoming_send_slate`].
#[derive(Debug, Clone)]
pub struct SignIncomingSendParams {
    /// Wallet's 64-byte BIP32 root.
    pub extended_private_key: [u8; 64],
    /// The S1 slate received from the sender (already parsed).
    pub s1_slate: SlateV4,
    /// 4-level BIP32 path for the receiver's new output. Caller is
    /// responsible for allocating a fresh `nChild` index.
    pub output_path: [u32; 4],
    /// Fresh kernel-signing nonce — generate via [`crate::random_secret_nonce`].
    pub receiver_kernel_nonce: [u8; 32],
    /// Bulletproof rewind nonce for the new output.
    pub bp_rewind_nonce: [u8; 32],
    /// Bulletproof private nonce.
    pub bp_private_nonce: [u8; 32],
}

/// Output of [`sign_incoming_send_slate`].
#[derive(Debug, Clone)]
pub struct SignIncomingSendOutput {
    /// The S2 slate, ready to encode back to the sender.
    pub slate: SlateV4,
    /// Info about the receiver's output — persist for spending later.
    pub output: ReceiverOutputInfo,
    /// Kernel-excess public-key commitment, 33-byte compressed point.
    /// Computed at S2 because both participants' xs are now known; the
    /// kernel offset is still zero in compact slates so this is the
    /// final on-chain kernel commitment. Stored in receive history so
    /// the wallet can correlate confirmed kernels to receive rows.
    /// (Legacy commit b6d3593 added this to receives.)
    pub kernel_excess: [u8; 33],
    /// Receiver context — retain for any post-S2 operations.
    pub context: ReceiverContext,
}

/// Sign an incoming S1 slate as the receiver, producing S2.
///
/// 1. Validate slate state is `Standard1`.
/// 2. Derive the receiver's output blind via `derive_blind` (Regular
///    switch) using `output_path` and the slate's `amt`.
/// 3. Call `receiver_round_s2` which constructs the receiver's output
///    (Pedersen + bulletproof), computes their partial signature
///    against the kernel-features signing message, appends both to the
///    slate, and bumps state to `Standard2`.
/// 4. Compute the kernel-excess public-key commitment as the point sum
///    of the sender's `xs` (in slate.sigs[0]) + receiver's `xs` (in
///    slate.sigs[1]). For compact slates with zero kernel offset
///    this is the final on-chain kernel commitment.
/// 5. Extract the receiver's output commitment + proof from the last
///    entry of slate.coms for the caller's persistence.
pub fn sign_incoming_send_slate(
    params: &SignIncomingSendParams,
) -> Result<SignIncomingSendOutput, String> {
    if params.s1_slate.sta != SlateStateV4::Standard1 {
        return Err(format!(
            "sign_incoming_send_slate expects S1, got {:?}",
            params.s1_slate.sta
        ));
    }

    // 1-2. Derive receiver's output blind for the slate's amount.
    let amount = params.s1_slate.amt;
    let output_blind = derive_blind(
        &params.extended_private_key,
        &params.output_path,
        amount,
        SwitchCommitmentType::Regular,
    )?;

    // 3. Run the receiver-round-s2 primitive. It mutates a clone of the
    //    input slate: pushes our output commitment + proof, our
    //    participant data (xs + nonce + partial sig), and flips the
    //    state to Standard2.
    let s2_out = receiver_round_s2(&ReceiverRoundParams {
        s1_slate: params.s1_slate.clone(),
        receiver_output_blind: output_blind,
        receiver_kernel_nonce: params.receiver_kernel_nonce,
        bp_rewind_nonce: params.bp_rewind_nonce,
        bp_private_nonce: params.bp_private_nonce,
        // Make the receiver output seed-recoverable (deterministic nonce +
        // embedded identifier message).
        extended_private_key: Some(params.extended_private_key),
        output_path: Some(params.output_path),
    })?;
    let s2_slate = s2_out.slate;

    // 4. Kernel-excess commitment for receive history. With compact
    //    slates the offset stays zero through both rounds, so the
    //    kernel public key is the simple point sum of the two xs.
    //    Sender's xs is sigs[0]; receiver's (ours) was just appended
    //    to sigs[1] by receiver_round_s2. Converted to commit form
    //    (08/09) so receiver's history shows the same kernel id that
    //    grincoin.org indexes and that sender's broadcast surfaces.
    let kernel_excess_pubkey = point_add(
        &s2_slate.sigs[0].xs,
        &s2_slate.sigs[1].xs,
    )?;
    let kernel_excess = pubkey_to_commitment(&kernel_excess_pubkey)?;

    // 5. Pull the receiver's output (we know it's the LAST entry in
    //    coms because receiver_round_s2 just pushed it).
    let coms = s2_slate
        .coms
        .as_ref()
        .ok_or("S2 slate is missing coms")?;
    let last = coms
        .last()
        .ok_or("S2 slate has empty coms after receiver_round_s2")?;
    let proof = last
        .p
        .clone()
        .ok_or("S2 slate's last com is missing its bulletproof — should be the receiver output")?;
    let output = ReceiverOutputInfo {
        path: params.output_path,
        amount,
        commitment: last.c,
        proof,
    };

    Ok(SignIncomingSendOutput {
        slate: s2_slate,
        output,
        kernel_excess,
        context: s2_out.context,
    })
}

// =============================================================================
// Finalize send (sender side: S2 → S3 → tx bytes)
// =============================================================================

/// Inputs to [`finalize_send_slate`].
#[derive(Debug, Clone)]
pub struct FinalizeSendParams {
    /// The S2 slate returned from the receiver.
    pub s2_slate: SlateV4,
    /// Sender context produced by `create_send_transaction` — holds
    /// the secret blind excess + kernel nonce + offset.
    pub sender_context: SenderContext,
    /// Same `inputs` array passed to `create_send_transaction`. The
    /// finalize step needs the input commitments + features to build
    /// the broadcastable transaction.
    pub sender_inputs: Vec<UnspentOutput>,
    /// Same change output info returned from `create_send_transaction`,
    /// if there was a change output. `None` if the transaction had no
    /// change (sweep mode).
    pub change_output: Option<ChangeOutputInfo>,
}

/// Output of [`finalize_send_slate`].
#[derive(Debug, Clone)]
pub struct FinalizeSendOutput {
    /// The S3 slate (all participants signed, kernel signature valid).
    pub slate: SlateV4,
    /// Aggregated 64-byte Schnorr signature for the kernel.
    pub final_signature: [u8; 64],
    /// Kernel-excess 33-byte commitment for sender's history record.
    pub kernel_excess: [u8; 33],
    /// Binary transaction bytes — wire format used by Grin P2P.
    pub tx_bytes: Vec<u8>,
    /// JSON-shaped transaction object — the format Grin's
    /// `/v2/foreign push_transaction` JSON-RPC endpoint expects as its
    /// `tx` parameter. Pass this through to the backend broadcast
    /// handler verbatim (don't wrap it in another object).
    pub tx_json: serde_json::Value,
}

/// Finalize a Grin send: verify the receiver's S2 partial signature,
/// produce the sender's partial, aggregate into the final kernel
/// signature, and build the broadcastable transaction bytes.
///
/// 1. Call `sender_finalize_s3` (verifies receiver's partial + aggregates).
/// 2. Compute the kernel-excess commitment (same point-sum as the
///    receiver computed at S2 — both arrive at the same value).
/// 3. Lift the sender's `UnspentOutput` list and optional change into
///    `TxInput` / `TxOutput` shapes for `slate_to_transaction_bytes`.
/// 4. Build the transaction binary.
pub fn finalize_send_slate(
    params: &FinalizeSendParams,
) -> Result<FinalizeSendOutput, String> {
    // 1. Sender's S2 → S3 transition.
    let final_out = sender_finalize_s3(&SenderFinalizeParams {
        s2_slate: params.s2_slate.clone(),
        sender_context: params.sender_context.clone(),
    })?;
    let s3_slate = final_out.slate;
    let final_signature = final_out.final_signature;

    // 2. Kernel-excess commitment — point sum of xs across all
    //    participants. Same value the receiver wrote into receive
    //    history at S2; sender uses it to correlate the on-chain
    //    kernel to this tx in their own history. Converted to the
    //    Pedersen commitment form (08/09 prefix) that grin-wallet,
    //    block explorers, and the on-chain `kernel.excess` use as the
    //    canonical "kernel id". The raw pubkey form (02/03) is what
    //    the schnorr math produces and is identical mod prefix — but
    //    consumers compare against grincoin.org which indexes by the
    //    commit form, so we expose that and only that.
    let kernel_excess_pubkey = point_add(&s3_slate.sigs[0].xs, &s3_slate.sigs[1].xs)?;
    let kernel_excess = pubkey_to_commitment(&kernel_excess_pubkey)?;

    // 3. Lift inputs / change into the transaction-builder shapes.
    let sender_inputs: Vec<TxInput> = params
        .sender_inputs
        .iter()
        .map(|u| TxInput {
            features: if u.is_coinbase { 1 } else { 0 },
            commitment: u.commitment,
        })
        .collect();

    // The slate's coms list currently holds inputs (from
    // create_send_transaction's add_input_commitment calls) + the
    // change output (from add_output_commitment) + the receiver's
    // output (from receiver_round_s2's append). Inputs are reflected
    // separately via `sender_inputs` here, so we need to NOT pass them
    // through slate.coms — slate_to_transaction_bytes already pulls
    // outputs from coms (filtering would double-count).
    //
    // Rebuild a coms list with ONLY outputs (the receiver's output and
    // any change). This is what compact-slate finalization conventionally
    // does — inputs live in the per-participant local state, outputs
    // travel with the slate.
    let mut outputs_only_coms = Vec::new();
    if let Some(coms) = &s3_slate.coms {
        for c in coms {
            // Output commitments have a bulletproof; input refs don't.
            if c.p.is_some() {
                outputs_only_coms.push(c.clone());
            }
        }
    }
    let mut s3_outputs_only = s3_slate.clone();
    s3_outputs_only.coms = Some(outputs_only_coms);

    let sender_change_outputs: Vec<TxOutput> = match &params.change_output {
        Some(ch) => {
            // Filter the change output out of the slate's coms too —
            // the transaction-builder appends sender_change_outputs to
            // the outputs derived from the slate, so passing change
            // here AND keeping it in slate.coms would double-count.
            // We KEEP it in slate.coms (since receiver_round_s2 added
            // it there) and pass an EMPTY sender_change_outputs to
            // avoid the double.
            //
            // Wait: the receiver_round_s2 only appends the RECEIVER's
            // output to coms. The sender's change is what
            // create_send_transaction added via add_output_commitment.
            // Both are in slate.coms after our flow.
            //
            // Simplest correct path: slate.coms contains every output
            // (receiver + change), inputs come from sender_inputs, and
            // sender_change_outputs is empty.
            let _ = ch; // suppress unused warning; change is in slate.coms
            Vec::new()
        }
        None => Vec::new(),
    };

    let build_params = BuildTransactionParams {
        s3_slate: s3_outputs_only,
        sender_inputs,
        sender_change_outputs,
        aggregated_kernel_signature: final_signature,
    };
    let tx_bytes = slate_to_transaction_bytes(&build_params)?;
    let tx_json = slate_to_transaction_json(&build_params)?;

    Ok(FinalizeSendOutput {
        slate: s3_slate,
        final_signature,
        kernel_excess,
        tx_bytes,
        tx_json,
    })
}

// =============================================================================
// Invoice ceremony (receiver-driven: I1 → I2 → I3)
// =============================================================================

/// Inputs to [`create_invoice`].
#[derive(Debug, Clone)]
pub struct CreateInvoiceParams {
    /// Receiver's 64-byte BIP32 root.
    pub extended_private_key: [u8; 64],
    /// Amount the receiver is requesting.
    pub amount: u64,
    /// Fee the sender will pay. The receiver declares the fee up-front
    /// in the invoice; sender accepts or rejects.
    pub fee: u64,
    pub kernel_features: KernelFeatures,
    /// 4-level BIP32 path where the receiver derives their new output.
    pub output_path: [u32; 4],
    pub kernel_offset: [u8; 32],
    pub receiver_kernel_nonce: [u8; 32],
    pub bp_rewind_nonce: [u8; 32],
    pub bp_private_nonce: [u8; 32],
    pub slate_id: Option<String>,
}

/// Output of [`create_invoice`].
#[derive(Debug, Clone)]
pub struct CreateInvoiceOutput {
    /// I1 slate to share with the payer.
    pub slate: SlateV4,
    /// Receiver context — required for the I3 finalize step.
    pub context: ReceiverContext,
    /// Info about the receiver's new output — persist so the wallet
    /// can spend it later.
    pub output: ReceiverOutputInfo,
}

/// Build the receiver's I1 slate (the invoice).
///
/// 1. Derive receiver's output blind via `derive_blind` (Regular).
/// 2. Call low-level `receiver_init_i1` which builds the slate +
///    the output's Pedersen commitment + bulletproof + the receiver's
///    participant data (xs + nonce; partial sig comes later at I3).
/// 3. Extract the receiver's output info (path + amount + commitment
///    + proof) for the wallet's persistence.
pub fn create_invoice(params: &CreateInvoiceParams) -> Result<CreateInvoiceOutput, String> {
    let output_blind = derive_blind(
        &params.extended_private_key,
        &params.output_path,
        params.amount,
        SwitchCommitmentType::Regular,
    )?;

    let init_params = ReceiverInitI1Params {
        amount: params.amount,
        fee: params.fee,
        kernel_features: params.kernel_features,
        receiver_output_blind: output_blind,
        receiver_kernel_nonce: params.receiver_kernel_nonce,
        bp_rewind_nonce: params.bp_rewind_nonce,
        bp_private_nonce: params.bp_private_nonce,
        kernel_offset: params.kernel_offset,
        // Make the invoice output seed-recoverable (deterministic nonce +
        // embedded identifier message).
        extended_private_key: Some(params.extended_private_key),
        output_path: Some(params.output_path),
    };
    let init_out = match &params.slate_id {
        Some(id) => {
            crate::slate_builder::receiver_init_i1_with_id(&init_params, id.clone())?
        }
        None => receiver_init_i1(&init_params)?,
    };

    // The receiver's output is the only entry in coms after I1.
    let coms = init_out
        .slate
        .coms
        .as_ref()
        .ok_or("I1 slate is missing coms")?;
    let first = coms
        .first()
        .ok_or("I1 slate has empty coms after receiver_init_i1")?;
    let proof = first
        .p
        .clone()
        .ok_or("I1 slate's output is missing its bulletproof")?;
    let output = ReceiverOutputInfo {
        path: params.output_path,
        amount: params.amount,
        commitment: first.c,
        proof,
    };

    Ok(CreateInvoiceOutput {
        slate: init_out.slate,
        context: init_out.context,
        output,
    })
}

/// Inputs to [`sign_invoice`].
#[derive(Debug, Clone)]
pub struct SignInvoiceParams {
    /// Sender's 64-byte BIP32 root (v3 / `useBip39=false`).
    pub extended_private_key: [u8; 64],
    /// LEGACY: optional v1/v2 ext key, same try-fallback semantics
    /// as `CreateSendTxParams::legacy_extended_private_key`.
    pub legacy_extended_private_key: Option<[u8; 64]>,
    /// I1 slate from the recipient.
    pub i1_slate: SlateV4,
    /// Sender's chosen UTXOs to fund the invoice.
    pub inputs: Vec<UnspentOutput>,
    /// 4-level BIP32 path for sender's change output, if any.
    pub change_path: [u32; 4],
    pub sender_kernel_nonce: [u8; 32],
    /// BP nonces for change output.
    pub bp_rewind_nonce: [u8; 32],
    pub bp_private_nonce: [u8; 32],
}

/// Output of [`sign_invoice`].
#[derive(Debug, Clone)]
pub struct SignInvoiceOutput {
    /// I2 slate, ready to return to the receiver.
    pub slate: SlateV4,
    /// Sender context — not strictly required for invoice flow
    /// (receiver finalizes), but useful for audit / debug.
    pub context: SenderContext,
    /// Info about the change output the sender created (if any).
    pub change_output: Option<ChangeOutputInfo>,
    /// Per-input derivation labels — see CreateSendTxOutput.
    pub input_derivations: Vec<String>,
}

/// Sign an invoice (I1 → I2) as the payer.
///
/// 1. Validate slate state is `Invoice1`.
/// 2. Derive each input's blinding factor; verify on-chain commitment.
/// 3. If `inputs_total > amount + fee`, derive change blind + Pedersen
///    + bulletproof. (Note: fee is dictated by the receiver in the
///    invoice; sender either accepts or rejects.)
/// 4. Compute `sender_blind_excess = change_blind − Σ input_blinds −
///    kernel_offset`. (Or `−Σ inputs − offset` with no change.)
/// 5. Call low-level `sender_round_i2` — appends sender's participant
///    data with their partial sig.
/// 6. Append sender's input commitments to slate.coms. Append change
///    output (commitment + proof) if any.
pub fn sign_invoice(params: &SignInvoiceParams) -> Result<SignInvoiceOutput, String> {
    if params.i1_slate.sta != SlateStateV4::Invoice1 {
        return Err(format!(
            "sign_invoice expects an I1 slate, got {:?}",
            params.i1_slate.sta
        ));
    }
    if params.inputs.is_empty() {
        return Err("sign_invoice: no inputs provided".into());
    }

    let amount = params.i1_slate.amt;
    let fee = params.i1_slate.fee;
    let target = amount.checked_add(fee).ok_or("amount + fee overflows u64")?;

    // Derive input blinds + verify commitments. Same try-fallback
    // wrapper as create_send_transaction — covers v3 → legacy ext-key
    // → switch=None and surfaces a diagnostic on total mismatch.
    let mut input_blinds = Vec::with_capacity(params.inputs.len());
    let mut input_derivations: Vec<String> = Vec::with_capacity(params.inputs.len());
    for input in &params.inputs {
        let (blind, label) = derive_input_blind_with_fallback(
            &params.extended_private_key,
            params.legacy_extended_private_key.as_ref(),
            input,
        )?;
        input_blinds.push(blind);
        input_derivations.push(label.to_string());
    }

    let inputs_total: u64 = params.inputs.iter().map(|i| i.amount).sum();
    if inputs_total < target {
        return Err(format!(
            "insufficient inputs: have {} nanogrin, need {} (amount + fee)",
            inputs_total, target
        ));
    }
    let change_amount = inputs_total - target;

    // Build change output if any.
    let (sender_output_blinds, change_output) = if change_amount > 0 {
        let change_blind = derive_blind(
            &params.extended_private_key,
            &params.change_path,
            change_amount,
            SwitchCommitmentType::Regular,
        )?;
        // Seed-recoverable change output: deterministic view-key rewind
        // nonce + embedded identifier message (see create_recoverable_output).
        let (change_commit, change_proof, _) = create_recoverable_output(
            &params.extended_private_key,
            change_amount,
            &change_blind,
            &params.change_path,
            SwitchCommitmentType::Regular,
            &params.bp_private_nonce,
        )?;
        (
            vec![change_blind],
            Some(ChangeOutputInfo {
                path: params.change_path,
                amount: change_amount,
                commitment: change_commit,
                proof: change_proof,
            }),
        )
    } else {
        (Vec::new(), None)
    };

    // Sender's blind excess scalar.
    let kernel_offset = params.i1_slate.off;
    let sender_blind_excess = crate::blind::sender_blind_excess(
        &input_blinds,
        &sender_output_blinds,
        &kernel_offset,
    );

    // I1 → I2: sender appends participant data with their partial sig.
    let round_out = sender_round_i2(&SenderRoundI2Params {
        i1_slate: params.i1_slate.clone(),
        sender_blind_excess,
        sender_kernel_nonce: params.sender_kernel_nonce,
    })?;
    let mut i2_slate = round_out.slate;

    // Append sender's input commitments + change output to slate.coms.
    for input in &params.inputs {
        add_input_commitment(&mut i2_slate, input.commitment, input.is_coinbase);
    }
    if let Some(change) = &change_output {
        add_output_commitment(&mut i2_slate, change.commitment, change.proof.clone(), false);
    }

    Ok(SignInvoiceOutput {
        slate: i2_slate,
        context: round_out.context,
        change_output,
        input_derivations,
    })
}

/// Inputs to [`finalize_invoice`].
#[derive(Debug, Clone)]
pub struct FinalizeInvoiceParams {
    /// I2 slate from the sender.
    pub i2_slate: SlateV4,
    /// Receiver context from `create_invoice`.
    pub receiver_context: ReceiverContext,
    /// Sender's inputs — included in the slate's coms after I2, but
    /// also needed separately for `slate_to_transaction_bytes` to
    /// build the binary transaction. Caller must provide them
    /// (or the receiver wallet must extract them from the slate
    /// and pass them through — see test for usage).
    pub sender_inputs: Vec<UnspentOutput>,
}

/// Output of [`finalize_invoice`].
#[derive(Debug, Clone)]
pub struct FinalizeInvoiceOutput {
    pub slate: SlateV4,
    pub final_signature: [u8; 64],
    pub kernel_excess: [u8; 33],
    pub tx_bytes: Vec<u8>,
    pub tx_json: serde_json::Value,
}

/// Finalize an invoice (I2 → I3) as the recipient: verify sender's
/// partial signature, contribute the receiver's partial, aggregate
/// into the final kernel signature, and emit the broadcastable
/// transaction bytes.
pub fn finalize_invoice(
    params: &FinalizeInvoiceParams,
) -> Result<FinalizeInvoiceOutput, String> {
    let final_out = receiver_finalize_i3(&ReceiverFinalizeI3Params {
        i2_slate: params.i2_slate.clone(),
        receiver_context: params.receiver_context.clone(),
    })?;
    let i3_slate = final_out.slate;
    let final_signature = final_out.final_signature;

    // Kernel excess commitment — same point sum as the send flow,
    // converted to canonical commitment form (08/09 prefix). See note
    // on the send-flow equivalent above.
    let kernel_excess_pubkey = point_add(&i3_slate.sigs[0].xs, &i3_slate.sigs[1].xs)?;
    let kernel_excess = pubkey_to_commitment(&kernel_excess_pubkey)?;

    // Build the transaction. Lift sender's inputs to TxInput; the
    // slate's coms list already holds receiver's output + sender's
    // change (both with proofs) and the sender's input refs
    // (no proofs). The transaction-builder filters by presence of a
    // proof to separate inputs from outputs, so we pass an empty
    // sender_change_outputs list and let the filtering handle it.
    let sender_inputs: Vec<TxInput> = params
        .sender_inputs
        .iter()
        .map(|u| TxInput {
            features: if u.is_coinbase { 1 } else { 0 },
            commitment: u.commitment,
        })
        .collect();

    // Slate.coms is mixed (input refs + outputs); filter to outputs only.
    let mut outputs_only_coms = Vec::new();
    if let Some(coms) = &i3_slate.coms {
        for c in coms {
            if c.p.is_some() {
                outputs_only_coms.push(c.clone());
            }
        }
    }
    let mut i3_outputs_only = i3_slate.clone();
    i3_outputs_only.coms = Some(outputs_only_coms);
    // slate_to_transaction_bytes expects state Standard3 — invoice
    // flow ends at Invoice3 which carries the same final kernel sig.
    // Patch the state so the transaction builder accepts it.
    i3_outputs_only.sta = SlateStateV4::Standard3;

    let build_params = BuildTransactionParams {
        s3_slate: i3_outputs_only,
        sender_inputs,
        sender_change_outputs: Vec::new(),
        aggregated_kernel_signature: final_signature,
    };
    let tx_bytes = slate_to_transaction_bytes(&build_params)?;
    let tx_json = slate_to_transaction_json(&build_params)?;

    Ok(FinalizeInvoiceOutput {
        slate: i3_slate,
        final_signature,
        kernel_excess,
        tx_bytes,
        tx_json,
    })
}

// ============================================================================
// Input-blind derivation with cross-derivation fallback
// ============================================================================

/// Try multiple derivation candidates to find one whose
/// `pedersen_commit(amount, blind)` matches the input's stored
/// commitment.
///
/// The candidate matrix is (ext_key) × (switch) × (depth):
///   - ext_key: v3 (modern), legacy v1/v2 (if `legacy_ext_key.is_some()`)
///   - switch: Regular (HF2 default), None (raw BIP32 child)
///   - depth: 4 (walk all path elements, our internal convention),
///            3 (walk first 3 elements — grin-wallet's `ExtKeychainPath`
///               default for standard outputs; the 4th u32 is just
///               serialization padding). Only enabled when path[3] == 0;
///               otherwise depth-3 would silently drop a meaningful step.
///
/// Without the depth-3 candidates, outputs created by external
/// grin-wallet / Grim (which always serialize the default account at
/// depth=3) appear at the right path in our DB but derive to the wrong
/// blind — see `depth_3_and_depth_4_derivations_diverge` regression
/// test. jwinterm's pre-2026-05 195.944 GRIN was the first user-visible
/// case (2026-05-15).
///
/// On total miss: returns a diagnostic listing each attempted blind's
/// computed commitment alongside the on-chain target so the surfaced
/// label points at the failure mode (key vs switch vs depth).
pub(crate) fn derive_input_blind_with_fallback(
    v3_ext_key: &[u8; 64],
    legacy_ext_key: Option<&[u8; 64]>,
    input: &UnspentOutput,
) -> Result<(/* blind */ [u8; 32], /* derivation_label */ &'static str), String> {
    // (label, ext_key, switch, path_slice).
    // path_slice is borrowed from input.path so we don't need to allocate
    // intermediate Vecs.
    let depth4_path = &input.path[..];
    let depth3_path = &input.path[..3];
    // Only consider the depth-3 candidates when the 4th element is the
    // expected zero padding. A non-zero 4th element implies the path
    // genuinely encodes 4 levels of derivation and shortening it would
    // produce nonsense.
    let allow_depth3 = input.path[3] == 0;

    let mut candidates: Vec<(&'static str, &[u8; 64], SwitchCommitmentType, &[u32])> =
        Vec::with_capacity(8);
    candidates.push(("v3+Regular+d4", v3_ext_key, SwitchCommitmentType::Regular, depth4_path));
    if let Some(legacy) = legacy_ext_key {
        candidates.push(("legacy+Regular+d4", legacy, SwitchCommitmentType::Regular, depth4_path));
    }
    if allow_depth3 {
        candidates.push(("v3+Regular+d3", v3_ext_key, SwitchCommitmentType::Regular, depth3_path));
        if let Some(legacy) = legacy_ext_key {
            candidates.push((
                "legacy+Regular+d3",
                legacy,
                SwitchCommitmentType::Regular,
                depth3_path,
            ));
        }
    }
    candidates.push(("v3+None+d4", v3_ext_key, SwitchCommitmentType::None, depth4_path));
    if let Some(legacy) = legacy_ext_key {
        candidates.push(("legacy+None+d4", legacy, SwitchCommitmentType::None, depth4_path));
    }
    if allow_depth3 {
        candidates.push(("v3+None+d3", v3_ext_key, SwitchCommitmentType::None, depth3_path));
        if let Some(legacy) = legacy_ext_key {
            candidates.push((
                "legacy+None+d3",
                legacy,
                SwitchCommitmentType::None,
                depth3_path,
            ));
        }
    }

    let mut diagnostics: Vec<String> = Vec::with_capacity(candidates.len());
    for (label, ext_key, switch, path) in &candidates {
        let blind = match derive_blind(ext_key, path, input.amount, *switch) {
            Ok(b) => b,
            Err(e) => {
                diagnostics.push(format!("  {} → derive_blind error: {}", label, e));
                continue;
            }
        };
        let commit = match pedersen_commit(input.amount, &blind) {
            Ok(c) => c,
            Err(e) => {
                diagnostics.push(format!("  {} → pedersen_commit error: {}", label, e));
                continue;
            }
        };
        if commit == input.commitment {
            return Ok((blind, *label));
        }
        diagnostics.push(format!("  {} → {}", label, hex::encode(commit)));
    }

    Err(format!(
        "input commitment mismatch at path {:?}, amount={}: \
         no candidate derivation reproduced the on-chain commit {}.\n\
         Tried:\n{}\n\
         If your wallet was previously used in v0.2.x at derivationVersion < 3 \
         (pre-2026-05 rotation), pass `legacy_extended_private_key` from \
         `mnemonic_to_extended_private_key_legacy_bip39`. If you've already \
         done that, the stored n_child / amount may not match what was \
         actually used at output creation — consider sweeping via grin-wallet \
         CLI / Grim with the same seed.",
        input.path,
        input.amount,
        hex::encode(input.commitment),
        diagnostics.join("\n"),
    ))
}

/// Recover the BIP32 path of one of our own on-chain outputs from its
/// commitment + value alone, so a stateless scan-based wallet can spend it.
///
/// The v3 `/wallet/grin/scan` returns `{commit, value, ...}` but NOT the
/// derivation path, while [`create_send_transaction`] REQUIRES each input's
/// `path` to re-derive its blinding factor. With no server-side output store to
/// look the path up in, we search for it: for each candidate child index `n` in
/// `0..=max_n`, try the standard Smirk layout `[0, 0, n, 0]` against the
/// existing candidate matrix ([`derive_input_blind_with_fallback`]:
/// v3/legacy × Regular/None × depth-3/4). The first `n` whose derived blind
/// reproduces `commitment` is this output's index; return its path.
///
/// This is pure reuse of the SAME matching logic `create_send_transaction`
/// applies per input — no new money logic. `is_coinbase` is irrelevant here (it
/// only changes kernel features, not the output's blinding factor), so we probe
/// with `false`.
///
/// Returns `None` if no index in range matches — the caller must then DROP that
/// output from the spendable set (never feed an unidentified input to the send
/// builder: a wrong path silently yields a bad blind and an invalid tx).
pub fn identify_output(
    v3_ext_key: &[u8; 64],
    legacy_ext_key: Option<&[u8; 64]>,
    commitment: [u8; 33],
    value: u64,
    max_n: u32,
) -> Option<[u32; 4]> {
    for n in 0..=max_n {
        let candidate = UnspentOutput {
            path: [0, 0, n, 0],
            amount: value,
            commitment,
            is_coinbase: false,
        };
        if derive_input_blind_with_fallback(v3_ext_key, legacy_ext_key, &candidate).is_ok() {
            return Some([0, 0, n, 0]);
        }
    }
    None
}
