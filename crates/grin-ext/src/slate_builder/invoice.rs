//! Invoice ceremony — receiver-driven (I1 → I2 → I3).
//!
//! Mirror of the standard flow with the roles swapped. UX win: the
//! receiver names the price (think "merchant pay-this-link") and the
//! sender funds it.
//!
//! - **I1** — receiver declares amount + their output (commit +
//!   bulletproof) + their pubkey/nonce.
//! - **I2** — sender adds their pubkey/nonce + partial sig.
//! - **I3** — receiver adds their partial + aggregates; produces final
//!   kernel sig.
//!
//! Same multi-party Schnorr math underneath — only the slate state codes
//! and "who's first" semantics differ from the standard ceremony.

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
// I1 — receiver init (the invoice)
// ============================================================================

/// Inputs for receiver-init (I1).
#[derive(Debug, Clone)]
pub struct ReceiverInitI1Params {
    pub amount: u64,
    pub fee: u64,
    pub kernel_features: KernelFeatures,
    pub receiver_output_blind: [u8; 32],
    pub receiver_kernel_nonce: [u8; 32],
    /// Legacy random rewind nonce — used ONLY when `extended_private_key` is
    /// `None` (the unused low-level binding path).
    pub bp_rewind_nonce: [u8; 32],
    pub bp_private_nonce: [u8; 32],
    /// Kernel offset — typically zero for invoices (receiver has no inputs
    /// to balance against), but caller may provide a random value.
    pub kernel_offset: [u8; 32],
    /// Wallet 64-byte extended private key. When set (the high-level
    /// `create_invoice` flow), the invoice output is **seed-recoverable**:
    /// deterministic view-key rewind nonce + embedded v3 identifier message.
    pub extended_private_key: Option<[u8; 64]>,
    /// The invoice output's depth-4 derivation path (`[0, 0, n, 0]`).
    /// Required alongside `extended_private_key` for a recoverable output.
    pub output_path: Option<[u32; 4]>,
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

    // Receiver creates their output (commit + bulletproof). With the wallet
    // ext key + output path (the high-level create_invoice flow), the output
    // is seed-recoverable; the unused low-level binding falls back to the
    // caller-supplied random rewind nonce.
    let (commitment, proof, rewind_nonce_used) =
        match (&params.extended_private_key, &params.output_path) {
            (Some(ext), Some(path)) => create_recoverable_output(
                ext,
                params.amount,
                &params.receiver_output_blind,
                path,
                SwitchCommitmentType::Regular,
                &params.bp_private_nonce,
            )?,
            _ => {
                let commitment = pedersen_commit(params.amount, &params.receiver_output_blind)?;
                let proof = bullet_proof_create(
                    params.amount,
                    &params.receiver_output_blind,
                    &params.bp_rewind_nonce,
                    &params.bp_private_nonce,
                )?;
                (commitment, proof, params.bp_rewind_nonce)
            }
        };

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
        rewind_nonce: rewind_nonce_used,
    };

    Ok(ReceiverInitI1Output { slate, context })
}

// ============================================================================
// I2 — sender round
// ============================================================================

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

// ============================================================================
// I3 — receiver finalize
// ============================================================================

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
