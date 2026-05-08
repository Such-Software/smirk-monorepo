//! Slate construction — building Grin transaction slates step by step.
//!
//! Grin transactions are interactively constructed across three states:
//!
//! ```text
//!   S1 (sender init)         — sender shares blind excess pubkey + nonce + offset
//!     ↓
//!   S2 (receiver round)      — receiver adds output + their pubkey/nonce + partial sig
//!     ↓
//!   S3 (sender finalize)     — sender adds partial sig, aggregates, kernel signed
//! ```
//!
//! This module ships the **sender_init_s1** entry today. The receiver round
//! and sender finalize land in subsequent commits.
//!
//! ## What's in S1
//!
//! Per a real `grin-wallet` `init_send_tx` response (see `FIXTURE_S1` in
//! `tests/`), an S1 slate contains only:
//! - version, id (UUID), state code "S1"
//! - kernel offset
//! - amount + fee
//! - one `ParticipantData` entry — the sender's `xs` (excess pubkey) and
//!   `nonce` (public nonce point). No partial signature yet.
//!
//! The sender's actual inputs + change output don't appear in the slate
//! at S1 — they're added later, or kept private and only their summed
//! commitments are committed to via the offset and excess key. This is
//! the "compact slate" model that Grin moved to in v4.

use uuid::Uuid;

use crate::bulletproof::{bullet_proof_create, pedersen_commit};
use crate::kernel::KernelFeatures;
use crate::schnorr::{
    aggregate_partials, final_signature, partial_sign, partial_verify, point_add, verify, Signature,
};
use crate::secp256k1::public_key_from_secret_key;
use crate::slate::{
    CommitsV4, KernelFeaturesArgsV4, ParticipantDataV4, SlateStateV4, SlateV4, VersionCompatInfoV4,
};

/// Inputs to the sender-init step.
#[derive(Debug, Clone)]
pub struct SenderInitParams {
    pub amount: u64,
    pub fee: u64,
    pub kernel_features: KernelFeatures,

    /// Sender's secret blind excess. Compute via
    /// [`crate::blind::sender_blind_excess`] from input blinds, output
    /// blinds, and the kernel offset.
    pub sender_blind_excess: [u8; 32],

    /// Kernel offset — random 32-byte scalar chosen by the sender.
    pub kernel_offset: [u8; 32],

    /// Sender's secret kernel-signing nonce — a fresh CSPRNG-derived 32-byte
    /// scalar that must NEVER be reused across slates.
    pub kernel_nonce: [u8; 32],
}

/// Output of the sender-init step. The slate is what gets serialized and
/// sent to the receiver. The context is private state the sender must
/// retain to complete the finalize step later.
#[derive(Debug, Clone)]
pub struct SenderInitOutput {
    pub slate: SlateV4,
    pub context: SenderContext,
}

/// Private state the sender holds between init and finalize. Don't share.
#[derive(Debug, Clone)]
pub struct SenderContext {
    pub slate_id: String,
    pub amount: u64,
    pub fee: u64,
    pub kernel_features: KernelFeatures,
    pub sender_blind_excess: [u8; 32],
    pub kernel_nonce: [u8; 32],
    pub kernel_offset: [u8; 32],
}

/// Build the sender's S1 slate.
///
/// Output is the slate to send to the receiver, plus a `SenderContext`
/// the sender must retain to complete the transaction at finalize time.
///
/// Generates a fresh v4 UUID for the slate ID. For environments where UUID
/// generation isn't available (e.g. some WASM targets without
/// `crypto.getRandomValues` reachable), use [`sender_init_s1_with_id`] and
/// supply your own UUID string.
pub fn sender_init_s1(params: &SenderInitParams) -> Result<SenderInitOutput, String> {
    let id = Uuid::new_v4().to_string();
    sender_init_s1_with_id(params, id)
}

/// Like [`sender_init_s1`] but the caller supplies the slate ID. UUID format
/// is recommended (matches `grin-wallet`) but not enforced.
pub fn sender_init_s1_with_id(
    params: &SenderInitParams,
    id: String,
) -> Result<SenderInitOutput, String> {

    // Compute the public versions of our blind excess + nonce.
    let xs = public_key_from_secret_key(&params.sender_blind_excess)
        .map_err(|e| format!("invalid sender blind excess: {e}"))?;
    let nonce = public_key_from_secret_key(&params.kernel_nonce)
        .map_err(|e| format!("invalid kernel nonce: {e}"))?;

    // Build the kernel features args (only present for HeightLocked / NRD).
    let feat_args = match params.kernel_features {
        KernelFeatures::HeightLocked { lock_height, .. } => Some(KernelFeaturesArgsV4 {
            lock_hgt: lock_height,
        }),
        KernelFeatures::Nrd {
            relative_height, ..
        } => Some(KernelFeaturesArgsV4 {
            lock_hgt: relative_height as u64,
        }),
        KernelFeatures::Plain { .. } | KernelFeatures::Coinbase => None,
    };

    let slate = SlateV4 {
        ver: VersionCompatInfoV4 {
            version: 4,
            block_header_version: 2,
        },
        id: id.clone(),
        sta: SlateStateV4::Standard1,
        off: params.kernel_offset,
        num_parts: 2,
        amt: params.amount,
        fee: params.fee,
        feat: params.kernel_features.feature_byte(),
        ttl: 0,
        sigs: vec![ParticipantDataV4 {
            xs,
            nonce,
            part: None,
        }],
        coms: None,
        proof: None,
        feat_args,
    };

    let context = SenderContext {
        slate_id: id,
        amount: params.amount,
        fee: params.fee,
        kernel_features: params.kernel_features,
        sender_blind_excess: params.sender_blind_excess,
        kernel_nonce: params.kernel_nonce,
        kernel_offset: params.kernel_offset,
    };

    Ok(SenderInitOutput { slate, context })
}

// =============================================================================
// Receiver round (S1 → S2)
// =============================================================================

/// Inputs to the receiver-round step. The receiver takes the sender's S1
/// slate, generates a new output for the amount they're receiving, computes
/// their partial signature, and produces an S2 slate.
#[derive(Debug, Clone)]
pub struct ReceiverRoundParams {
    /// The S1 slate received from the sender.
    pub s1_slate: SlateV4,

    /// Receiver's secret blinding factor for the new output. Must be a
    /// fresh value derived from the wallet seed (or a random scalar for
    /// throwaway receivers).
    pub receiver_output_blind: [u8; 32],

    /// Receiver's secret kernel-signing nonce — fresh CSPRNG-derived 32
    /// bytes that must NEVER be reused across slates.
    pub receiver_kernel_nonce: [u8; 32],

    /// Rewind nonce for the bulletproof. Lets the receiver later recover
    /// the value from the rangeproof using their seed-derived nonce.
    /// Typically `BLAKE2b(seed_secret_key, commitment)` or similar.
    pub bp_rewind_nonce: [u8; 32],

    /// Private (one-time) nonce for bulletproof creation.
    pub bp_private_nonce: [u8; 32],
}

/// Output of the receiver round. The slate is what gets returned to the
/// sender. The context is private state the receiver retains for any
/// later operations (e.g. recovering the value via BP rewind on chain).
#[derive(Debug, Clone)]
pub struct ReceiverRoundOutput {
    pub slate: SlateV4,
    pub context: ReceiverContext,
}

/// Private state the receiver holds after the round.
#[derive(Debug, Clone)]
pub struct ReceiverContext {
    pub slate_id: String,
    pub amount: u64,
    pub output_blind: [u8; 32],
    pub kernel_nonce: [u8; 32],
    pub commitment: [u8; 33],
    pub rewind_nonce: [u8; 32],
}

/// Run the receiver round: take an S1 slate, add a new output (commitment
/// + bulletproof), compute the receiver's partial signature, return the
/// S2 slate.
pub fn receiver_round_s2(params: &ReceiverRoundParams) -> Result<ReceiverRoundOutput, String> {
    if params.s1_slate.sta != SlateStateV4::Standard1 {
        return Err(format!(
            "receiver_round_s2 expects an S1 slate, got {:?}",
            params.s1_slate.sta
        ));
    }
    if params.s1_slate.sigs.len() != 1 {
        return Err(format!(
            "S1 slate must contain exactly 1 sigs entry (the sender), got {}",
            params.s1_slate.sigs.len()
        ));
    }

    // Reconstruct the kernel features from the slate fields so we can
    // compute the same signing message the sender will compute at finalize.
    let kernel_features = KernelFeatures::from_slate_fields(
        params.s1_slate.feat,
        params.s1_slate.fee,
        params.s1_slate.feat_args.as_ref().map(|a| a.lock_hgt),
    )?;
    let msg = kernel_features.sig_msg()?;

    // Derive receiver's public excess + nonce.
    let p_r = public_key_from_secret_key(&params.receiver_output_blind)
        .map_err(|e| format!("invalid receiver output blind: {e}"))?;
    let r_r = public_key_from_secret_key(&params.receiver_kernel_nonce)
        .map_err(|e| format!("invalid receiver kernel nonce: {e}"))?;

    // Sender's public excess + nonce — already in the slate.
    let sender_sig = &params.s1_slate.sigs[0];

    // Shared challenge sums.
    let p_total = point_add(&sender_sig.xs, &p_r)?;
    let r_total = point_add(&sender_sig.nonce, &r_r)?;

    // Receiver's partial signature.
    let partial_s = partial_sign(
        &params.receiver_output_blind,
        &params.receiver_kernel_nonce,
        &r_total,
        &p_total,
        &msg,
    )?;

    // Sanity-check our own partial verifies — catches bugs in our math
    // before they leave the wallet.
    let ok = partial_verify(&partial_s, &r_r, &p_r, &r_total, &p_total, &msg)?;
    if !ok {
        return Err("receiver partial signature failed self-verification".to_string());
    }

    // Build the receiver's output: Pedersen commitment + bulletproof.
    let amount = params.s1_slate.amt;
    let commitment = pedersen_commit(amount, &params.receiver_output_blind)?;
    let proof = bullet_proof_create(
        amount,
        &params.receiver_output_blind,
        &params.bp_rewind_nonce,
        &params.bp_private_nonce,
    )?;

    // Append receiver's commitment + proof to the slate's coms list.
    let mut coms = params.s1_slate.coms.clone().unwrap_or_default();
    coms.push(CommitsV4 {
        f: 0, // Plain output
        c: commitment,
        p: Some(proof),
    });

    // Append receiver's participant data (with their partial signature).
    // Slate stores the partial as 64 bytes — see `partial_to_slate_part`.
    let mut sigs = params.s1_slate.sigs.clone();
    sigs.push(ParticipantDataV4 {
        xs: p_r,
        nonce: r_r,
        part: Some(partial_to_slate_part(&r_total, &partial_s)),
    });

    let mut s2 = params.s1_slate.clone();
    s2.sta = SlateStateV4::Standard2;
    s2.sigs = sigs;
    s2.coms = Some(coms);

    let context = ReceiverContext {
        slate_id: s2.id.clone(),
        amount,
        output_blind: params.receiver_output_blind,
        kernel_nonce: params.receiver_kernel_nonce,
        commitment,
        rewind_nonce: params.bp_rewind_nonce,
    };

    Ok(ReceiverRoundOutput { slate: s2, context })
}

// =============================================================================
// Sender finalize (S2 → S3)
// =============================================================================

/// Inputs to the sender-finalize step.
#[derive(Debug, Clone)]
pub struct SenderFinalizeParams {
    /// The S2 slate received back from the receiver.
    pub s2_slate: SlateV4,

    /// The sender context produced by `sender_init_s1` for this slate.
    pub sender_context: SenderContext,
}

/// Output of finalize. The slate moves to S3 (ready to broadcast); the
/// `final_signature` is the aggregated 64-byte Schnorr signature for the
/// kernel — verified to be valid before this function returns.
#[derive(Debug, Clone)]
pub struct SenderFinalizeOutput {
    pub slate: SlateV4,
    pub final_signature: [u8; 64],
}

/// Run the sender's finalize step: verify the receiver's partial, compute
/// the sender's partial, aggregate them, build + verify the final kernel
/// signature, and return the S3 slate.
pub fn sender_finalize_s3(
    params: &SenderFinalizeParams,
) -> Result<SenderFinalizeOutput, String> {
    if params.s2_slate.sta != SlateStateV4::Standard2 {
        return Err(format!(
            "sender_finalize_s3 expects an S2 slate, got {:?}",
            params.s2_slate.sta
        ));
    }
    if params.s2_slate.sigs.len() != 2 {
        return Err(format!(
            "S2 slate must contain exactly 2 sigs entries (sender + receiver), got {}",
            params.s2_slate.sigs.len()
        ));
    }
    if params.s2_slate.id != params.sender_context.slate_id {
        return Err(format!(
            "slate_id mismatch: slate has {:?}, context has {:?}",
            params.s2_slate.id, params.sender_context.slate_id
        ));
    }

    let sender_sig = &params.s2_slate.sigs[0];
    let receiver_sig = &params.s2_slate.sigs[1];

    let receiver_part_64 = receiver_sig
        .part
        .ok_or_else(|| "S2 slate missing receiver partial signature".to_string())?;
    let receiver_partial = slate_part_to_partial(&receiver_part_64);

    // Also extract the R-component from the receiver's `part` for the
    // consistency check below (must match the computed R_total).
    let receiver_part_r_x: [u8; 32] = receiver_part_64[..32]
        .try_into()
        .expect("64-byte slice has 32-byte prefix");

    // Reconstruct kernel features from slate fields → signing message.
    let kernel_features = KernelFeatures::from_slate_fields(
        params.s2_slate.feat,
        params.s2_slate.fee,
        params.s2_slate.feat_args.as_ref().map(|a| a.lock_hgt),
    )?;
    let msg = kernel_features.sig_msg()?;

    // Compute totals from the slate participants.
    let p_total = point_add(&sender_sig.xs, &receiver_sig.xs)?;
    let r_total = point_add(&sender_sig.nonce, &receiver_sig.nonce)?;

    // Consistency: the R-component the receiver embedded in their `part`
    // must match the R_total we just computed. Catches tampering on the
    // R-half of the receiver's partial.
    if receiver_part_r_x != r_total[1..33] {
        return Err(
            "receiver `part` R-component doesn't match computed R_total — slate tampered with"
                .to_string(),
        );
    }

    // Verify the receiver's partial before producing ours.
    let ok = partial_verify(
        &receiver_partial,
        &receiver_sig.nonce,
        &receiver_sig.xs,
        &r_total,
        &p_total,
        &msg,
    )?;
    if !ok {
        return Err("receiver partial signature does not verify".to_string());
    }

    // Sender's partial.
    let sender_partial = partial_sign(
        &params.sender_context.sender_blind_excess,
        &params.sender_context.kernel_nonce,
        &r_total,
        &p_total,
        &msg,
    )?;

    // Aggregate.
    let s_total = aggregate_partials(&[sender_partial, receiver_partial])?;

    // Build + verify the final aggregated signature.
    let final_sig = final_signature(&r_total, &s_total);
    let ok = verify(&final_sig, &msg, &p_total)?;
    if !ok {
        return Err("aggregated signature failed verification — slate construction has a bug".to_string());
    }

    // Update the slate: sender's partial + state advance.
    let mut sigs = params.s2_slate.sigs.clone();
    sigs[0].part = Some(partial_to_slate_part(&r_total, &sender_partial));

    let mut s3 = params.s2_slate.clone();
    s3.sta = SlateStateV4::Standard3;
    s3.sigs = sigs;

    Ok(SenderFinalizeOutput {
        slate: s3,
        final_signature: extract_sig_bytes(&final_sig),
    })
}

/// Extract the 64-byte compact sig bytes from a Signature wrapper.
fn extract_sig_bytes(sig: &Signature) -> [u8; 64] {
    sig.0
}

// =============================================================================
// Invoice flow — receiver-initiated transactions (I1 → I2 → I3)
// =============================================================================
//
// Mirror of the standard flow with the roles swapped:
//
//   I1 (receiver init)        — receiver declares amount + their output
//                                (commit + bulletproof) + their pubkey/nonce
//     ↓
//   I2 (sender round)         — sender adds their pubkey/nonce + partial sig
//     ↓
//   I3 (receiver finalize)    — receiver adds their partial + aggregates;
//                                produces final kernel sig
//
// Same multi-party Schnorr math underneath — only the slate state codes
// and "who's first" semantics differ. UX win: invoice flow is the
// "merchant pay-this-link" pattern — the receiver names the price.

/// Inputs for receiver-init (I1).
#[derive(Debug, Clone)]
pub struct ReceiverInitI1Params {
    pub amount: u64,
    pub fee: u64,
    pub kernel_features: KernelFeatures,
    pub receiver_output_blind: [u8; 32],
    pub receiver_kernel_nonce: [u8; 32],
    pub bp_rewind_nonce: [u8; 32],
    pub bp_private_nonce: [u8; 32],
    /// Kernel offset — typically zero for invoices (receiver has no inputs
    /// to balance against), but caller may provide a random value.
    pub kernel_offset: [u8; 32],
}

#[derive(Debug, Clone)]
pub struct ReceiverInitI1Output {
    pub slate: SlateV4,
    pub context: ReceiverContext,
}

/// Build the receiver's I1 slate (the invoice). The receiver creates their
/// output upfront and shares it with the sender, who'll fund it.
pub fn receiver_init_i1(params: &ReceiverInitI1Params) -> Result<ReceiverInitI1Output, String> {
    let id = Uuid::new_v4().to_string();
    receiver_init_i1_with_id(params, id)
}

/// As [`receiver_init_i1`] but with a caller-supplied slate ID. Useful in
/// WASM environments where UUID generation isn't available.
pub fn receiver_init_i1_with_id(
    params: &ReceiverInitI1Params,
    id: String,
) -> Result<ReceiverInitI1Output, String> {
    // Receiver's public excess + nonce.
    let xs = public_key_from_secret_key(&params.receiver_output_blind)
        .map_err(|e| format!("invalid receiver output blind: {e}"))?;
    let nonce = public_key_from_secret_key(&params.receiver_kernel_nonce)
        .map_err(|e| format!("invalid receiver kernel nonce: {e}"))?;

    // Receiver creates their output (commit + bulletproof).
    let commitment = pedersen_commit(params.amount, &params.receiver_output_blind)?;
    let proof = bullet_proof_create(
        params.amount,
        &params.receiver_output_blind,
        &params.bp_rewind_nonce,
        &params.bp_private_nonce,
    )?;

    let feat_args = match params.kernel_features {
        KernelFeatures::HeightLocked { lock_height, .. } => Some(KernelFeaturesArgsV4 {
            lock_hgt: lock_height,
        }),
        KernelFeatures::Nrd {
            relative_height, ..
        } => Some(KernelFeaturesArgsV4 {
            lock_hgt: relative_height as u64,
        }),
        KernelFeatures::Plain { .. } | KernelFeatures::Coinbase => None,
    };

    let slate = SlateV4 {
        ver: VersionCompatInfoV4 {
            version: 4,
            block_header_version: 2,
        },
        id: id.clone(),
        sta: SlateStateV4::Invoice1,
        off: params.kernel_offset,
        num_parts: 2,
        amt: params.amount,
        fee: params.fee,
        feat: params.kernel_features.feature_byte(),
        ttl: 0,
        sigs: vec![ParticipantDataV4 {
            xs,
            nonce,
            part: None,
        }],
        coms: Some(vec![CommitsV4 {
            f: 0, // Plain output
            c: commitment,
            p: Some(proof),
        }]),
        proof: None,
        feat_args,
    };

    let context = ReceiverContext {
        slate_id: id,
        amount: params.amount,
        output_blind: params.receiver_output_blind,
        kernel_nonce: params.receiver_kernel_nonce,
        commitment,
        rewind_nonce: params.bp_rewind_nonce,
    };

    Ok(ReceiverInitI1Output { slate, context })
}

/// Inputs for sender-round (I2).
#[derive(Debug, Clone)]
pub struct SenderRoundI2Params {
    pub i1_slate: SlateV4,
    /// Sender's secret blind excess (computed from input/change blinds + the
    /// slate's existing kernel offset).
    pub sender_blind_excess: [u8; 32],
    pub sender_kernel_nonce: [u8; 32],
}

#[derive(Debug, Clone)]
pub struct SenderRoundI2Output {
    pub slate: SlateV4,
    pub context: SenderContext,
}

/// Sender's response to an invoice. They contribute their partial signature
/// using the kernel-signing message reconstructed from the invoice's fields.
pub fn sender_round_i2(params: &SenderRoundI2Params) -> Result<SenderRoundI2Output, String> {
    if params.i1_slate.sta != SlateStateV4::Invoice1 {
        return Err(format!(
            "sender_round_i2 expects an I1 slate, got {:?}",
            params.i1_slate.sta
        ));
    }
    if params.i1_slate.sigs.len() != 1 {
        return Err(format!(
            "I1 slate must contain exactly 1 sigs entry (the receiver), got {}",
            params.i1_slate.sigs.len()
        ));
    }

    let kernel_features = KernelFeatures::from_slate_fields(
        params.i1_slate.feat,
        params.i1_slate.fee,
        params.i1_slate.feat_args.as_ref().map(|a| a.lock_hgt),
    )?;
    let msg = kernel_features.sig_msg()?;

    let xs = public_key_from_secret_key(&params.sender_blind_excess)
        .map_err(|e| format!("invalid sender blind excess: {e}"))?;
    let nonce = public_key_from_secret_key(&params.sender_kernel_nonce)
        .map_err(|e| format!("invalid sender kernel nonce: {e}"))?;

    let receiver_sig = &params.i1_slate.sigs[0];
    let p_total = point_add(&receiver_sig.xs, &xs)?;
    let r_total = point_add(&receiver_sig.nonce, &nonce)?;

    let partial_s = partial_sign(
        &params.sender_blind_excess,
        &params.sender_kernel_nonce,
        &r_total,
        &p_total,
        &msg,
    )?;

    // Self-verify before sending.
    let ok = partial_verify(&partial_s, &nonce, &xs, &r_total, &p_total, &msg)?;
    if !ok {
        return Err("sender partial signature failed self-verification".to_string());
    }

    let mut sigs = params.i1_slate.sigs.clone();
    sigs.push(ParticipantDataV4 {
        xs,
        nonce,
        part: Some(partial_to_slate_part(&r_total, &partial_s)),
    });

    let mut i2 = params.i1_slate.clone();
    i2.sta = SlateStateV4::Invoice2;
    i2.sigs = sigs;

    let context = SenderContext {
        slate_id: i2.id.clone(),
        amount: i2.amt,
        fee: i2.fee,
        kernel_features,
        sender_blind_excess: params.sender_blind_excess,
        kernel_nonce: params.sender_kernel_nonce,
        kernel_offset: i2.off,
    };

    Ok(SenderRoundI2Output { slate: i2, context })
}

/// Inputs for receiver-finalize (I3).
#[derive(Debug, Clone)]
pub struct ReceiverFinalizeI3Params {
    pub i2_slate: SlateV4,
    /// The receiver context produced by `receiver_init_i1` for this slate.
    pub receiver_context: ReceiverContext,
}

#[derive(Debug, Clone)]
pub struct ReceiverFinalizeI3Output {
    pub slate: SlateV4,
    pub final_signature: [u8; 64],
}

/// Receiver's finalize: verify sender's partial, contribute their own,
/// aggregate, and produce the final kernel signature.
pub fn receiver_finalize_i3(
    params: &ReceiverFinalizeI3Params,
) -> Result<ReceiverFinalizeI3Output, String> {
    if params.i2_slate.sta != SlateStateV4::Invoice2 {
        return Err(format!(
            "receiver_finalize_i3 expects an I2 slate, got {:?}",
            params.i2_slate.sta
        ));
    }
    if params.i2_slate.sigs.len() != 2 {
        return Err(format!(
            "I2 slate must contain exactly 2 sigs entries (receiver + sender), got {}",
            params.i2_slate.sigs.len()
        ));
    }
    if params.i2_slate.id != params.receiver_context.slate_id {
        return Err(format!(
            "slate_id mismatch: slate has {:?}, context has {:?}",
            params.i2_slate.id, params.receiver_context.slate_id
        ));
    }

    let receiver_sig = &params.i2_slate.sigs[0];
    let sender_sig = &params.i2_slate.sigs[1];

    let sender_part_64 = sender_sig
        .part
        .ok_or_else(|| "I2 slate missing sender partial signature".to_string())?;
    let sender_partial = slate_part_to_partial(&sender_part_64);
    let sender_part_r_x: [u8; 32] = sender_part_64[..32]
        .try_into()
        .expect("64-byte slice has 32-byte prefix");

    let kernel_features = KernelFeatures::from_slate_fields(
        params.i2_slate.feat,
        params.i2_slate.fee,
        params.i2_slate.feat_args.as_ref().map(|a| a.lock_hgt),
    )?;
    let msg = kernel_features.sig_msg()?;

    let p_total = point_add(&receiver_sig.xs, &sender_sig.xs)?;
    let r_total = point_add(&receiver_sig.nonce, &sender_sig.nonce)?;

    if sender_part_r_x != r_total[1..33] {
        return Err(
            "sender `part` R-component doesn't match computed R_total — slate tampered with"
                .to_string(),
        );
    }

    let ok = partial_verify(
        &sender_partial,
        &sender_sig.nonce,
        &sender_sig.xs,
        &r_total,
        &p_total,
        &msg,
    )?;
    if !ok {
        return Err("sender partial signature does not verify".to_string());
    }

    // Receiver's partial.
    let receiver_partial = partial_sign(
        &params.receiver_context.output_blind,
        &params.receiver_context.kernel_nonce,
        &r_total,
        &p_total,
        &msg,
    )?;

    let s_total = aggregate_partials(&[receiver_partial, sender_partial])?;
    let final_sig = final_signature(&r_total, &s_total);
    let ok = verify(&final_sig, &msg, &p_total)?;
    if !ok {
        return Err(
            "aggregated signature failed verification — slate construction has a bug".to_string(),
        );
    }

    let mut sigs = params.i2_slate.sigs.clone();
    sigs[0].part = Some(partial_to_slate_part(&r_total, &receiver_partial));

    let mut i3 = params.i2_slate.clone();
    i3.sta = SlateStateV4::Invoice3;
    i3.sigs = sigs;

    Ok(ReceiverFinalizeI3Output {
        slate: i3,
        final_signature: extract_sig_bytes(&final_sig),
    })
}

/// Pack a partial-signature scalar into the 64-byte representation Grin
/// stores in `slate.sigs[i].part`. The format is `R_total_x_only (32) ||
/// partial_s (32)` — the R component echoes the shared aggregate nonce,
/// matching what `aggsig::sign_single` produces with `pub_nonce_total`
/// supplied. Verification reconstructs R_total from sums of all
/// participants' `nonce` fields and uses `partial_s` for the actual
/// signature check.
fn partial_to_slate_part(r_total: &[u8; 33], partial_s: &[u8; 32]) -> [u8; 64] {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&r_total[1..33]);
    out[32..].copy_from_slice(partial_s);
    out
}

/// Inverse of `partial_to_slate_part` — recover the partial scalar from a
/// slate `part` field. We don't validate the R component here; the caller
/// already has R_total computed from the slate's `nonce` fields.
fn slate_part_to_partial(slate_part: &[u8; 64]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&slate_part[32..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slate::serialize_slate_v4;

    fn det(b: u8) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[31] = b.max(1); // ensure non-zero
        out
    }

    #[test]
    fn sender_init_produces_valid_s1() {
        let params = SenderInitParams {
            amount: 60_000_000_000,
            fee: 7_000_000,
            kernel_features: KernelFeatures::Plain { fee: 7_000_000 },
            sender_blind_excess: det(11),
            kernel_offset: det(22),
            kernel_nonce: det(33),
        };
        let out = sender_init_s1(&params).expect("sender_init succeeds");

        // Shape checks.
        assert_eq!(out.slate.sta, SlateStateV4::Standard1);
        assert_eq!(out.slate.amt, 60_000_000_000);
        assert_eq!(out.slate.fee, 7_000_000);
        assert_eq!(out.slate.sigs.len(), 1);
        assert!(out.slate.sigs[0].part.is_none(), "sender hasn't signed yet at S1");
        assert!(out.slate.coms.is_none(), "S1 has no coms in compact slate");
        assert_eq!(out.slate.off, det(22), "offset matches input");
        assert_eq!(out.slate.feat, 0, "Plain kernel feature byte");
    }

    #[test]
    fn sender_init_serializes_to_valid_v4_json() {
        let params = SenderInitParams {
            amount: 1_000_000_000,
            fee: 8_000_000,
            kernel_features: KernelFeatures::Plain { fee: 8_000_000 },
            sender_blind_excess: det(7),
            kernel_offset: det(8),
            kernel_nonce: det(9),
        };
        let out = sender_init_s1(&params).unwrap();
        let json = serialize_slate_v4(&out.slate).expect("serialize");
        assert!(json.contains(r#""sta":"S1""#));
        assert!(json.contains(r#""ver":"4:2""#));
        assert!(json.contains(r#""amt":"1000000000""#));
    }

    #[test]
    fn slate_id_is_unique_per_call() {
        let params = SenderInitParams {
            amount: 1,
            fee: 1,
            kernel_features: KernelFeatures::Plain { fee: 1 },
            sender_blind_excess: det(1),
            kernel_offset: det(2),
            kernel_nonce: det(3),
        };
        let a = sender_init_s1(&params).unwrap();
        let b = sender_init_s1(&params).unwrap();
        assert_ne!(a.slate.id, b.slate.id, "each S1 gets a fresh UUID");
    }

    #[test]
    fn nrd_kernel_emits_feat_args_with_relative_height() {
        let params = SenderInitParams {
            amount: 1,
            fee: 1,
            kernel_features: KernelFeatures::Nrd {
                fee: 1,
                relative_height: 1440,
            },
            sender_blind_excess: det(1),
            kernel_offset: det(2),
            kernel_nonce: det(3),
        };
        let out = sender_init_s1(&params).unwrap();
        assert_eq!(out.slate.feat, 3);
        let args = out.slate.feat_args.expect("NRD has feat_args");
        assert_eq!(args.lock_hgt, 1440);
    }

    #[test]
    fn height_locked_emits_feat_args_with_lock_height() {
        let params = SenderInitParams {
            amount: 1,
            fee: 1,
            kernel_features: KernelFeatures::HeightLocked {
                fee: 1,
                lock_height: 500_000,
            },
            sender_blind_excess: det(1),
            kernel_offset: det(2),
            kernel_nonce: det(3),
        };
        let out = sender_init_s1(&params).unwrap();
        assert_eq!(out.slate.feat, 2);
        assert_eq!(out.slate.feat_args.unwrap().lock_hgt, 500_000);
    }

    #[test]
    fn plain_kernel_omits_feat_args() {
        let params = SenderInitParams {
            amount: 1,
            fee: 1,
            kernel_features: KernelFeatures::Plain { fee: 1 },
            sender_blind_excess: det(1),
            kernel_offset: det(2),
            kernel_nonce: det(3),
        };
        let out = sender_init_s1(&params).unwrap();
        assert!(out.slate.feat_args.is_none());
    }

    #[test]
    fn context_carries_secret_state_for_finalize() {
        let params = SenderInitParams {
            amount: 100,
            fee: 5,
            kernel_features: KernelFeatures::Plain { fee: 5 },
            sender_blind_excess: det(11),
            kernel_offset: det(22),
            kernel_nonce: det(33),
        };
        let out = sender_init_s1(&params).unwrap();
        assert_eq!(out.context.slate_id, out.slate.id);
        assert_eq!(out.context.sender_blind_excess, det(11));
        assert_eq!(out.context.kernel_nonce, det(33));
        assert_eq!(out.context.kernel_offset, det(22));
    }

    // =========================================================================
    // Receiver round (S1 → S2) tests
    // =========================================================================

    /// Build a complete S1 slate to feed into receiver tests.
    fn build_s1(amount: u64, fee: u64, features: KernelFeatures) -> SenderInitOutput {
        sender_init_s1(&SenderInitParams {
            amount,
            fee,
            kernel_features: features,
            sender_blind_excess: det(11),
            kernel_offset: det(22),
            kernel_nonce: det(33),
        })
        .unwrap()
    }

    #[test]
    fn receiver_round_produces_valid_s2() {
        let s1 = build_s1(60_000_000_000, 7_000_000, KernelFeatures::Plain { fee: 7_000_000 });

        let out = receiver_round_s2(&ReceiverRoundParams {
            s1_slate: s1.slate,
            receiver_output_blind: det(101),
            receiver_kernel_nonce: det(102),
            bp_rewind_nonce: det(103),
            bp_private_nonce: det(104),
        })
        .expect("receiver round succeeds");

        assert_eq!(out.slate.sta, SlateStateV4::Standard2);
        assert_eq!(out.slate.sigs.len(), 2, "S2 has both sender + receiver sigs");
        assert!(out.slate.sigs[1].part.is_some(), "receiver added their partial");
        assert!(out.slate.sigs[0].part.is_none(), "sender hasn't signed yet");
        let coms = out.slate.coms.as_ref().expect("S2 has coms");
        assert_eq!(coms.len(), 1, "receiver's output is the only entry");
        assert_eq!(coms[0].f, 0, "Plain output");
        assert!(coms[0].p.is_some(), "rangeproof present");
    }

    #[test]
    fn receiver_round_rejects_non_s1() {
        let mut s1_with_wrong_state =
            build_s1(100, 5, KernelFeatures::Plain { fee: 5 }).slate;
        s1_with_wrong_state.sta = SlateStateV4::Standard2; // not S1

        let result = receiver_round_s2(&ReceiverRoundParams {
            s1_slate: s1_with_wrong_state,
            receiver_output_blind: det(1),
            receiver_kernel_nonce: det(2),
            bp_rewind_nonce: det(3),
            bp_private_nonce: det(4),
        });
        assert!(result.is_err());
    }

    // =========================================================================
    // Sender finalize (S2 → S3) tests
    // =========================================================================

    /// Run the full S1 → S2 → S3 ceremony with deterministic inputs.
    /// Returns (final_s3_slate, final_aggregated_signature).
    fn run_full_ceremony(
        amount: u64,
        fee: u64,
        features: KernelFeatures,
    ) -> ([u8; 64], SlateV4) {
        let init = sender_init_s1(&SenderInitParams {
            amount,
            fee,
            kernel_features: features,
            sender_blind_excess: det(11),
            kernel_offset: det(22),
            kernel_nonce: det(33),
        })
        .unwrap();

        let s2 = receiver_round_s2(&ReceiverRoundParams {
            s1_slate: init.slate,
            receiver_output_blind: det(101),
            receiver_kernel_nonce: det(102),
            bp_rewind_nonce: det(103),
            bp_private_nonce: det(104),
        })
        .unwrap();

        let s3 = sender_finalize_s3(&SenderFinalizeParams {
            s2_slate: s2.slate,
            sender_context: init.context,
        })
        .unwrap();

        (s3.final_signature, s3.slate)
    }

    #[test]
    fn full_ceremony_produces_verifiable_aggregate_signature() {
        let (sig, slate) = run_full_ceremony(
            60_000_000_000,
            7_000_000,
            KernelFeatures::Plain { fee: 7_000_000 },
        );
        assert_eq!(sig.len(), 64);
        assert_eq!(slate.sta, SlateStateV4::Standard3);
        assert!(slate.sigs[0].part.is_some(), "sender's partial in S3");
        assert!(slate.sigs[1].part.is_some(), "receiver's partial in S3");

        // Verify the final aggregated signature against P_total = sender.xs + receiver.xs.
        let p_total = crate::schnorr::point_add(&slate.sigs[0].xs, &slate.sigs[1].xs).unwrap();
        let kernel_features = KernelFeatures::Plain { fee: 7_000_000 };
        let msg = kernel_features.sig_msg().unwrap();
        let signature = crate::schnorr::Signature::from_bytes(sig);
        assert!(crate::schnorr::verify(&signature, &msg, &p_total).unwrap());
    }

    #[test]
    fn full_ceremony_works_with_nrd_kernel() {
        let (sig, slate) = run_full_ceremony(
            1_000_000_000,
            8_000_000,
            KernelFeatures::Nrd {
                fee: 8_000_000,
                relative_height: 1440,
            },
        );
        assert_eq!(slate.feat, 3);
        assert_eq!(slate.feat_args.unwrap().lock_hgt, 1440);

        // Verify final sig with the reconstructed kernel features.
        let p_total = crate::schnorr::point_add(&slate.sigs[0].xs, &slate.sigs[1].xs).unwrap();
        let kernel_features = KernelFeatures::Nrd {
            fee: 8_000_000,
            relative_height: 1440,
        };
        let msg = kernel_features.sig_msg().unwrap();
        let signature = crate::schnorr::Signature::from_bytes(sig);
        assert!(crate::schnorr::verify(&signature, &msg, &p_total).unwrap());
    }

    #[test]
    fn finalize_rejects_non_s2() {
        let init = sender_init_s1(&SenderInitParams {
            amount: 100,
            fee: 5,
            kernel_features: KernelFeatures::Plain { fee: 5 },
            sender_blind_excess: det(11),
            kernel_offset: det(22),
            kernel_nonce: det(33),
        })
        .unwrap();

        // Pass an S1 (not S2) slate.
        let result = sender_finalize_s3(&SenderFinalizeParams {
            s2_slate: init.slate,
            sender_context: init.context,
        });
        assert!(result.is_err());
    }

    #[test]
    fn finalize_rejects_tampered_receiver_partial() {
        let init = sender_init_s1(&SenderInitParams {
            amount: 100,
            fee: 5,
            kernel_features: KernelFeatures::Plain { fee: 5 },
            sender_blind_excess: det(11),
            kernel_offset: det(22),
            kernel_nonce: det(33),
        })
        .unwrap();
        let mut s2 = receiver_round_s2(&ReceiverRoundParams {
            s1_slate: init.slate,
            receiver_output_blind: det(101),
            receiver_kernel_nonce: det(102),
            bp_rewind_nonce: det(103),
            bp_private_nonce: det(104),
        })
        .unwrap();

        // Flip a bit in the receiver's partial signature.
        let mut tampered = s2.slate.sigs[1].part.unwrap();
        tampered[0] ^= 0x01;
        s2.slate.sigs[1].part = Some(tampered);

        let result = sender_finalize_s3(&SenderFinalizeParams {
            s2_slate: s2.slate,
            sender_context: init.context,
        });
        assert!(result.is_err(), "finalize must reject tampered receiver partial");
    }

    // =========================================================================
    // Invoice flow tests (I1 → I2 → I3)
    // =========================================================================

    #[test]
    fn receiver_init_i1_produces_valid_invoice() {
        let out = receiver_init_i1(&ReceiverInitI1Params {
            amount: 1_000_000_000,
            fee: 8_000_000,
            kernel_features: KernelFeatures::Plain { fee: 8_000_000 },
            receiver_output_blind: det(101),
            receiver_kernel_nonce: det(102),
            bp_rewind_nonce: det(103),
            bp_private_nonce: det(104),
            kernel_offset: [0u8; 32], // typical for invoices
        })
        .unwrap();

        assert_eq!(out.slate.sta, SlateStateV4::Invoice1);
        assert_eq!(out.slate.amt, 1_000_000_000);
        assert_eq!(out.slate.sigs.len(), 1, "I1 has only the receiver");
        assert!(out.slate.sigs[0].part.is_none(), "no signatures yet at I1");
        let coms = out.slate.coms.expect("I1 has the receiver's output");
        assert_eq!(coms.len(), 1);
        assert_eq!(coms[0].f, 0); // Plain output
        assert!(coms[0].p.is_some(), "rangeproof present from receiver");
    }

    #[test]
    fn full_invoice_ceremony_produces_verifiable_aggregate_signature() {
        let amount = 1_000_000_000u64;
        let fee = 8_000_000u64;
        let features = KernelFeatures::Plain { fee };

        // Receiver creates the invoice.
        let i1 = receiver_init_i1(&ReceiverInitI1Params {
            amount,
            fee,
            kernel_features: features,
            receiver_output_blind: det(101),
            receiver_kernel_nonce: det(102),
            bp_rewind_nonce: det(103),
            bp_private_nonce: det(104),
            kernel_offset: [0u8; 32],
        })
        .unwrap();

        // Sender responds.
        let i2 = sender_round_i2(&SenderRoundI2Params {
            i1_slate: i1.slate,
            sender_blind_excess: det(11),
            sender_kernel_nonce: det(33),
        })
        .unwrap();

        assert_eq!(i2.slate.sta, SlateStateV4::Invoice2);
        assert_eq!(i2.slate.sigs.len(), 2);
        assert!(i2.slate.sigs[0].part.is_none(), "receiver hasn't signed yet at I2");
        assert!(i2.slate.sigs[1].part.is_some(), "sender's partial in I2");

        // Receiver finalizes.
        let i3 = receiver_finalize_i3(&ReceiverFinalizeI3Params {
            i2_slate: i2.slate,
            receiver_context: i1.context,
        })
        .unwrap();

        assert_eq!(i3.slate.sta, SlateStateV4::Invoice3);
        assert!(i3.slate.sigs[0].part.is_some(), "receiver's partial in I3");
        assert!(i3.slate.sigs[1].part.is_some(), "sender's partial in I3");

        // Verify the final aggregate sig as a normal Schnorr against P_total.
        let p_total =
            crate::schnorr::point_add(&i3.slate.sigs[0].xs, &i3.slate.sigs[1].xs).unwrap();
        let msg = features.sig_msg().unwrap();
        let signature = crate::schnorr::Signature::from_bytes(i3.final_signature);
        assert!(crate::schnorr::verify(&signature, &msg, &p_total).unwrap());
    }

    #[test]
    fn invoice_flow_rejects_non_i1_in_sender_round() {
        // Build an S1 (not I1) slate and try to feed it to sender_round_i2.
        let s1 = sender_init_s1(&SenderInitParams {
            amount: 1,
            fee: 1,
            kernel_features: KernelFeatures::Plain { fee: 1 },
            sender_blind_excess: det(11),
            kernel_offset: det(22),
            kernel_nonce: det(33),
        })
        .unwrap()
        .slate;
        let result = sender_round_i2(&SenderRoundI2Params {
            i1_slate: s1,
            sender_blind_excess: det(11),
            sender_kernel_nonce: det(33),
        });
        assert!(result.is_err());
    }

    #[test]
    fn invoice_finalize_rejects_tampered_sender_partial() {
        let i1 = receiver_init_i1(&ReceiverInitI1Params {
            amount: 1_000_000_000,
            fee: 8_000_000,
            kernel_features: KernelFeatures::Plain { fee: 8_000_000 },
            receiver_output_blind: det(101),
            receiver_kernel_nonce: det(102),
            bp_rewind_nonce: det(103),
            bp_private_nonce: det(104),
            kernel_offset: [0u8; 32],
        })
        .unwrap();

        let mut i2 = sender_round_i2(&SenderRoundI2Params {
            i1_slate: i1.slate,
            sender_blind_excess: det(11),
            sender_kernel_nonce: det(33),
        })
        .unwrap();

        // Tamper with the sender's partial scalar.
        let mut tampered = i2.slate.sigs[1].part.unwrap();
        tampered[32] ^= 0x01; // flip a bit in the scalar half
        i2.slate.sigs[1].part = Some(tampered);

        let result = receiver_finalize_i3(&ReceiverFinalizeI3Params {
            i2_slate: i2.slate,
            receiver_context: i1.context,
        });
        assert!(result.is_err());
    }

    #[test]
    fn finalize_rejects_mismatched_slate_id() {
        let init_a = sender_init_s1(&SenderInitParams {
            amount: 100,
            fee: 5,
            kernel_features: KernelFeatures::Plain { fee: 5 },
            sender_blind_excess: det(11),
            kernel_offset: det(22),
            kernel_nonce: det(33),
        })
        .unwrap();
        let init_b = sender_init_s1(&SenderInitParams {
            amount: 200,
            fee: 6,
            kernel_features: KernelFeatures::Plain { fee: 6 },
            sender_blind_excess: det(44),
            kernel_offset: det(55),
            kernel_nonce: det(66),
        })
        .unwrap();
        let s2 = receiver_round_s2(&ReceiverRoundParams {
            s1_slate: init_a.slate,
            receiver_output_blind: det(101),
            receiver_kernel_nonce: det(102),
            bp_rewind_nonce: det(103),
            bp_private_nonce: det(104),
        })
        .unwrap();

        // Try to finalize with the WRONG sender context (mismatched slate_id).
        let result = sender_finalize_s3(&SenderFinalizeParams {
            s2_slate: s2.slate,
            sender_context: init_b.context,
        });
        assert!(result.is_err(), "finalize must reject mismatched slate_id");
    }
}
