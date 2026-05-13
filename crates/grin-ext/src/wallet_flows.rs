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
use crate::slate::{add_input_commitment, add_output_commitment, SlateV4};
use crate::slate_builder::{sender_init_s1, SenderContext, SenderInitParams};

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
