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

use crate::kernel::KernelFeatures;
use crate::secp256k1::public_key_from_secret_key;
use crate::slate::{
    KernelFeaturesArgsV4, ParticipantDataV4, SlateStateV4, SlateV4, VersionCompatInfoV4,
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
}
