//! WASM exports for Grin / Mimblewimble functionality.
//!
//! Each export is a thin wrapper over a `grin-ext` function, returning JSON
//! for ergonomic consumption from TypeScript. The JSON shape mirrors the
//! return values of the existing `smirk-extension/src/lib/grin/wallet.ts`
//! functions so the eventual TS migration is a drop-in replacement.
//!
//! ## Module layout
//!
//! Submodules group exports by topic. The public function names (and thus
//! the wasm-bindgen-exported JS symbols) are unchanged from the previous
//! single-file layout — `pub use` re-exports preserve the surface.
//!
//! - [`keys`] — seed → extended key, address derivation, slatepack address
//! - [`schnorr`] — single-signer Schnorr sign / verify
//! - [`multiparty`] — point ops + multi-party Schnorr aggregation
//! - [`adaptor`] — Schnorr adaptor signatures (atomic-swap building block)
//! - [`bulletproof`] — Pedersen commit + Bulletproof create / verify / rewind
//! - [`blind`] — scalar arithmetic helpers
//! - [`slate`] — slate v4 round-trip + summary helpers
//! - [`slate_builder`] — full S1→S2→S3 + I1→I2→I3 ceremonies
//! - [`kernel`] — kernel features serialization + sig-message hash
//! - [`transaction`] — finalized slate → broadcastable TX bytes
//! - [`payment_proof`] — ed25519 receiver-signed payment receipts
//! - [`slatepack`] — ASCII armor + binary codec + age encryption

use wasm_bindgen::prelude::*;

mod adaptor;
mod blind;
mod bulletproof;
mod kernel;
mod keys;
mod multiparty;
mod payment_proof;
mod schnorr;
mod slate;
mod slate_builder;
mod slatepack;
mod transaction;
mod voucher;
mod wallet_flows;

// ---------- Public re-exports ----------
//
// Listed in the same order they appeared in the original single-file
// version so `crates/smirk-wasm/src/lib.rs` keeps importing the same
// symbol names.

pub use adaptor::{
    grin_adaptor_complete, grin_adaptor_extract_secret, grin_adaptor_partial_sign,
    grin_adaptor_partial_verify,
};
pub use blind::{grin_blind_add, grin_blind_sub, grin_blind_sum, grin_sender_blind_excess};
pub use bulletproof::{
    grin_bullet_proof_create, grin_bullet_proof_rewind, grin_bullet_proof_verify,
    grin_pedersen_commit,
};
pub use kernel::{grin_kernel_features_bytes, grin_kernel_sig_msg};
pub use keys::{
    grin_derive_extended_key, grin_derive_keys, grin_secp256k1_public_key,
    grin_slatepack_address, grin_slatepack_address_secret, grin_slatepack_address_to_pubkey_hex,
};
pub use multiparty::{
    grin_point_add, grin_point_sum, grin_schnorr_aggregate_partials,
    grin_schnorr_final_signature, grin_schnorr_partial_sign, grin_schnorr_partial_verify,
};
pub use payment_proof::{grin_sign_payment_proof, grin_verify_payment_proof};
pub use schnorr::{grin_schnorr_sign, grin_schnorr_verify};
pub use slate::{grin_slate_round_trip, grin_slate_summary};
pub use slate_builder::{
    grin_receiver_finalize_i3, grin_receiver_init_i1, grin_receiver_round_s2,
    grin_sender_finalize_s3, grin_sender_init_s1, grin_sender_round_i2,
};
pub use slatepack::{
    grin_slatepack_armor, grin_slatepack_bin_decode, grin_slatepack_bin_encode_plain,
    grin_slatepack_dearmor, grin_slatepack_decrypt, grin_slatepack_encrypt,
    grin_slatepack_pack_encrypted, grin_slatepack_pack_plain, grin_slatepack_unpack,
    grin_slatepack_unpack_with_secret,
};
pub use transaction::{grin_pubkey_to_commitment, grin_slate_to_transaction_bytes};
pub use voucher::{grin_create_grin_voucher, grin_sweep_grin_voucher};
pub use wallet_flows::{
    grin_create_invoice, grin_create_send_transaction, grin_finalize_invoice,
    grin_finalize_send_slate, grin_random_secret_nonce, grin_sign_incoming_send_slate,
    grin_sign_invoice, grin_slate_v4_from_bin_hex, grin_slate_v4_to_bin_hex,
};

/// grin-ext crate version. Useful for runtime version sanity checks.
#[wasm_bindgen]
pub fn grin_ext_version() -> String {
    grin_ext::VERSION.to_string()
}

// ---------- Shared internal helpers ----------

/// Build a [`grin_ext::KernelFeatures`] from the `(kind, fee, lock_height,
/// relative_height)` quadruple that several wasm exports take. Centralized
/// here so kernel/, slate_builder/, etc. all parse the same string forms.
pub(super) fn build_kernel_features(
    kind: &str,
    fee: Option<u64>,
    lock_height: Option<u64>,
    relative_height: Option<u32>,
) -> Result<grin_ext::KernelFeatures, JsValue> {
    match kind {
        "plain" => Ok(grin_ext::KernelFeatures::Plain {
            fee: fee.ok_or_else(|| JsValue::from_str("plain kernels require fee"))?,
        }),
        "coinbase" => Ok(grin_ext::KernelFeatures::Coinbase),
        "height_locked" => {
            let fee = fee.ok_or_else(|| JsValue::from_str("height_locked kernels require fee"))?;
            let lock_height = lock_height
                .ok_or_else(|| JsValue::from_str("height_locked kernels require lock_height"))?;
            Ok(grin_ext::KernelFeatures::HeightLocked { fee, lock_height })
        }
        "nrd" => {
            let fee = fee.ok_or_else(|| JsValue::from_str("nrd kernels require fee"))?;
            let rh = relative_height
                .ok_or_else(|| JsValue::from_str("nrd kernels require relative_height"))?;
            if rh > u16::MAX as u32 {
                return Err(JsValue::from_str(&format!(
                    "relative_height {rh} > u16::MAX"
                )));
            }
            Ok(grin_ext::KernelFeatures::Nrd {
                fee,
                relative_height: rh as u16,
            })
        }
        other => Err(JsValue::from_str(&format!(
            "unknown kernel kind {other:?}; expected plain, coinbase, height_locked, or nrd"
        ))),
    }
}
