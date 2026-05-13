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

use crate::bulletproof::{bullet_proof_create, pedersen_commit};
use crate::keychain::{derive_blind, SwitchCommitmentType};
use crate::kernel::KernelFeatures;
use crate::schnorr::point_add;
use crate::slate::{
    add_input_commitment, add_output_commitment, SlateStateV4, SlateV4,
};
use crate::slate_builder::{
    receiver_round_s2, sender_finalize_s3, sender_init_s1, ReceiverContext, ReceiverRoundParams,
    SenderContext, SenderFinalizeParams, SenderInitParams,
};
use crate::transaction::{
    slate_to_transaction_bytes, BuildTransactionParams, TxInput, TxOutput,
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
    pub extended_private_key: [u8; 64],
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
    let mut input_blinds = Vec::with_capacity(params.inputs.len());
    for input in &params.inputs {
        let blind = derive_blind(
            &params.extended_private_key,
            &input.path,
            input.amount,
            SwitchCommitmentType::Regular,
        )?;
        // Sanity check: re-deriving the commitment from blind + amount
        // must produce the on-chain commitment. Catches stored-path /
        // stored-commitment mismatches before the slate is built (an
        // input reference that doesn't actually correspond to the
        // wallet's UTXO is unspendable + would cause kernel-sum
        // verification to fail at the receiver).
        let derived = pedersen_commit(input.amount, &blind)?;
        if derived != input.commitment {
            return Err(format!(
                "input commitment mismatch at path {:?}: re-derived commitment does not match stored value",
                input.path
            ));
        }
        input_blinds.push(blind);
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
        let change_commit = pedersen_commit(change_amount, &change_blind)?;
        let change_proof = bullet_proof_create(
            change_amount,
            &change_blind,
            &params.bp_rewind_nonce,
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
    })?;
    let s2_slate = s2_out.slate;

    // 4. Kernel-excess commitment for receive history. With compact
    //    slates the offset stays zero through both rounds, so the
    //    kernel public key is the simple point sum of the two xs.
    //    Sender's xs is sigs[0]; receiver's (ours) was just appended
    //    to sigs[1] by receiver_round_s2.
    let kernel_excess = point_add(
        &s2_slate.sigs[0].xs,
        &s2_slate.sigs[1].xs,
    )?;

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
    /// Binary transaction bytes ready to POST to the Grin daemon's
    /// `/v2/foreign push_transaction` endpoint (wrapped in JSON by the
    /// backend layer).
    pub tx_bytes: Vec<u8>,
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
    //    kernel to this tx in their own history.
    let kernel_excess = point_add(&s3_slate.sigs[0].xs, &s3_slate.sigs[1].xs)?;

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

    let tx_bytes = slate_to_transaction_bytes(&BuildTransactionParams {
        s3_slate: s3_outputs_only,
        sender_inputs,
        sender_change_outputs,
        aggregated_kernel_signature: final_signature,
    })?;

    Ok(FinalizeSendOutput {
        slate: s3_slate,
        final_signature,
        kernel_excess,
        tx_bytes,
    })
}
