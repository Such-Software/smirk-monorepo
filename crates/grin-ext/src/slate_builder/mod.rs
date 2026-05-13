//! Slate construction — building Grin transaction slates step by step.
//!
//! Two ceremonies, each three states:
//!
//! ```text
//! Standard (sender-driven):
//!   S1 (sender init)         — sender shares blind excess pubkey + nonce + offset
//!     ↓
//!   S2 (receiver round)      — receiver adds output + their pubkey/nonce + partial sig
//!     ↓
//!   S3 (sender finalize)     — sender adds partial sig, aggregates, kernel signed
//!
//! Invoice (receiver-driven, "pay this invoice" UX):
//!   I1 (receiver init)       — receiver declares amount + their output + pubkey/nonce
//!     ↓
//!   I2 (sender round)        — sender adds their pubkey/nonce + partial sig
//!     ↓
//!   I3 (receiver finalize)   — receiver adds their partial + aggregates kernel sig
//! ```
//!
//! Same multi-party Schnorr math underneath both flows — the difference is
//! who's first and what the slate looks like at each state. Each ceremony
//! lives in its own submodule:
//!
//! - [`standard`] — `sender_init_s1`, `receiver_round_s2`, `sender_finalize_s3`
//! - [`invoice`]  — `receiver_init_i1`, `sender_round_i2`, `receiver_finalize_i3`
//!
//! The shared `SenderContext` and `ReceiverContext` types live here at the
//! module root because both ceremonies use them: the sender persists a
//! `SenderContext` across rounds in either flow; ditto the receiver.
//!
//! ## What's in S1 / I1
//!
//! Per a real `grin-wallet` `init_send_tx` response, an S1 slate contains
//! only:
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
//!
//! I1 is similar but inverted: the receiver's output (commit + bulletproof)
//! IS in the slate at I1 since the receiver knows the amount; the sender's
//! inputs/change get added in I2.

use crate::kernel::KernelFeatures;
use crate::schnorr::Signature;

mod invoice;
mod standard;

#[cfg(test)]
mod tests;

pub use invoice::{
    receiver_finalize_i3, receiver_init_i1, receiver_init_i1_with_id, sender_round_i2,
    ReceiverFinalizeI3Output, ReceiverFinalizeI3Params, ReceiverInitI1Output,
    ReceiverInitI1Params, SenderRoundI2Output, SenderRoundI2Params,
};
pub use standard::{
    receiver_round_s2, sender_finalize_s3, sender_init_s1, sender_init_s1_with_id,
    ReceiverRoundOutput, ReceiverRoundParams, SenderFinalizeOutput, SenderFinalizeParams,
    SenderInitOutput, SenderInitParams,
};

// ============================================================================
// Shared persistent state — used by both ceremonies
// ============================================================================

/// Private state the sender holds between init and finalize. Don't share.
///
/// Serializable so wallet shells can persist the context (in session
/// state, IndexedDB, etc.) across the slate-exchange round-trip — the
/// sender may close the popup between sending S1 and receiving S2.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SenderContext {
    pub slate_id: String,
    pub amount: u64,
    pub fee: u64,
    pub kernel_features: KernelFeatures,
    #[serde(with = "crate::slate::hex_serde")]
    pub sender_blind_excess: [u8; 32],
    #[serde(with = "crate::slate::hex_serde")]
    pub kernel_nonce: [u8; 32],
    #[serde(with = "crate::slate::hex_serde")]
    pub kernel_offset: [u8; 32],
}

/// Private state the receiver holds between rounds. Serializable for
/// the same popup-close-survives-roundtrip reason as SenderContext.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReceiverContext {
    pub slate_id: String,
    pub amount: u64,
    #[serde(with = "crate::slate::hex_serde")]
    pub output_blind: [u8; 32],
    #[serde(with = "crate::slate::hex_serde")]
    pub kernel_nonce: [u8; 32],
    #[serde(with = "crate::slate::hex_serde_33")]
    pub commitment: [u8; 33],
    #[serde(with = "crate::slate::hex_serde")]
    pub rewind_nonce: [u8; 32],
}

// ============================================================================
// Shared private helpers — partial-signature ↔ slate-part encoding
// ============================================================================

/// Pack a partial-signature scalar into the 64-byte representation Grin
/// stores in `slate.sigs[i].part`. The format is `R_total_x_only (32) ||
/// partial_s (32)` — the R component echoes the shared aggregate nonce,
/// matching what `aggsig::sign_single` produces with `pub_nonce_total`
/// supplied. Verification reconstructs R_total from sums of all
/// participants' `nonce` fields and uses `partial_s` for the actual
/// signature check.
pub(super) fn partial_to_slate_part(r_total: &[u8; 33], partial_s: &[u8; 32]) -> [u8; 64] {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&r_total[1..33]);
    out[32..].copy_from_slice(partial_s);
    out
}

/// Inverse of [`partial_to_slate_part`] — recover the partial scalar from
/// a slate `part` field. We don't validate the R component here; the
/// caller already has R_total computed from the slate's `nonce` fields.
pub(super) fn slate_part_to_partial(slate_part: &[u8; 64]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&slate_part[32..]);
    out
}

/// Extract the 64-byte compact sig bytes from a Signature wrapper.
pub(super) fn extract_sig_bytes(sig: &Signature) -> [u8; 64] {
    sig.0
}
