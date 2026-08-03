//! Standard ceremony: sender-driven (S1 → S2 → S3).
//!
//! - **S1**: sender shares `xs` + `nonce` + `offset` and the amount/fee.
//! - **S2**: receiver appends their output + their partial signature.
//! - **S3**: sender appends their partial, aggregates, and verifies.

use uuid::Uuid;

use crate::bulletproof::{bullet_proof_create, pedersen_commit};
use crate::keychain::SwitchCommitmentType;
use crate::kernel::KernelFeatures;
use crate::recovery::create_recoverable_output;
use crate::schnorr::{
    aggregate_partials, final_signature, partial_sign, partial_verify, point_add, verify,
};
use crate::secp256k1::public_key_from_secret_key;
use crate::slate::{
    CommitsV4, KernelFeaturesArgsV4, ParticipantDataV4, SlateStateV4, SlateV4, VersionCompatInfoV4,
};

use super::{
    extract_sig_bytes, partial_to_slate_part, slate_part_to_partial, ReceiverContext,
    SenderContext,
};

// ============================================================================
// S1: sender init
// ============================================================================

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

    /// Kernel offset: random 32-byte scalar chosen by the sender.
    pub kernel_offset: [u8; 32],

    /// Sender's secret kernel-signing nonce: a fresh CSPRNG-derived 32-byte
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
            lock_hgt: u64::from(relative_height),
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

// ============================================================================
// S2: receiver round
// ============================================================================

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

    /// Receiver's secret kernel-signing nonce: fresh CSPRNG-derived 32
    /// bytes that must NEVER be reused across slates.
    pub receiver_kernel_nonce: [u8; 32],

    /// Legacy random rewind nonce: used ONLY when `extended_private_key`
    /// is `None` (the unused low-level binding path). High-level flows set
    /// the ext key + path below for a deterministic, seed-recoverable nonce.
    pub bp_rewind_nonce: [u8; 32],

    /// Private (one-time) nonce for bulletproof creation.
    pub bp_private_nonce: [u8; 32],

    /// Wallet 64-byte extended private key. When set (all high-level flows),
    /// the receiver output is created **seed-recoverable**: deterministic
    /// view-key rewind nonce + embedded v3 identifier message.
    pub extended_private_key: Option<[u8; 64]>,

    /// The receiver output's depth-4 derivation path (`[0, 0, n, 0]`).
    /// Required alongside `extended_private_key` for a recoverable output.
    pub output_path: Option<[u32; 4]>,
}

/// Output of the receiver round. The slate is what gets returned to the
/// sender. The context is private state the receiver retains for any
/// later operations (e.g. recovering the value via BP rewind on chain).
#[derive(Debug, Clone)]
pub struct ReceiverRoundOutput {
    pub slate: SlateV4,
    pub context: ReceiverContext,
}

/// Run the receiver round: take an S1 slate, add a new output
/// (commitment + bulletproof), compute the receiver's partial signature,
/// return the S2 slate.
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

    // Sender's public excess + nonce: already in the slate.
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

    // Sanity-check our own partial verifies: catches bugs in our math
    // before they leave the wallet.
    let ok = partial_verify(&partial_s, &r_r, &p_r, &r_total, &p_total, &msg)?;
    if !ok {
        return Err("receiver partial signature failed self-verification".to_string());
    }

    // Build the receiver's output: Pedersen commitment + bulletproof. With
    // the wallet ext key + output path (all high-level flows), the output is
    // seed-recoverable (deterministic view-key nonce + embedded identifier
    // message). The unused low-level binding leaves them None and falls back
    // to the caller-supplied random rewind nonce.
    let amount = params.s1_slate.amt;
    let (commitment, proof, rewind_nonce_used) =
        match (&params.extended_private_key, &params.output_path) {
            (Some(ext), Some(path)) => create_recoverable_output(
                ext,
                amount,
                &params.receiver_output_blind,
                path,
                SwitchCommitmentType::Regular,
                &params.bp_private_nonce,
            )?,
            _ => {
                let commitment = pedersen_commit(amount, &params.receiver_output_blind)?;
                let proof = bullet_proof_create(
                    amount,
                    &params.receiver_output_blind,
                    &params.bp_rewind_nonce,
                    &params.bp_private_nonce,
                )?;
                (commitment, proof, params.bp_rewind_nonce)
            }
        };

    // Append receiver's commitment + proof to the slate's coms list.
    let mut coms = params.s1_slate.coms.clone().unwrap_or_default();
    coms.push(CommitsV4 {
        f: 0, // Plain output
        c: commitment,
        p: Some(proof),
    });

    // Append receiver's participant data (with their partial signature).
    // Slate stores the partial as 64 bytes; see `partial_to_slate_part`.
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
        rewind_nonce: rewind_nonce_used,
    };

    Ok(ReceiverRoundOutput { slate: s2, context })
}

// ============================================================================
// S3: sender finalize
// ============================================================================

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
/// kernel, verified to be valid before this function returns.
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
