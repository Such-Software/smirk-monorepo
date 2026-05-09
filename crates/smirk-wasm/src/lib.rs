//! # smirk-wasm
//!
//! Monero/Wownero transaction construction for browser extensions.
//!
//! This crate provides WASM bindings for constructing and signing Monero and Wownero
//! transactions client-side, using data provided by a Light Wallet Server (LWS).
//!
//! ## Architecture
//!
//! The extension holds the spend key locally. The backend (via LWS) provides:
//! - Unspent outputs (`get_unspent_outs`)
//! - Decoy ring members (`get_random_outs`)
//! - Fee information
//!
//! This WASM module constructs and signs transactions without the spend key
//! ever leaving the client.
//!
//! ## Functions
//!
//! - [`test`] - Verify WASM is loaded
//! - [`version`] - Get library version
//! - [`validate_address`] - Validate Monero/Wownero addresses
//! - [`derive_key_image`] - Compute key images for spend detection
//! - [`parse_tx`] - Parse transaction from hex
//! - [`estimate_fee`] - Estimate transaction fees
//! - [`sign_transaction`] - Build and sign transactions
//! - [`derive_output_key_image`] - Derive key image for a specific output (requires output_key)
//! - [`compute_key_image`] - Compute key image from wallet keys and tx_pub_key (no output_key needed)

use wasm_bindgen::prelude::*;

mod address;
mod bitcoin;
mod grin;
mod keys;
mod output;
mod result;
mod signing;
#[cfg(test)]
mod tests;
mod transaction;

// Re-export public functions
pub use address::validate_address;
pub use bitcoin::{btc_derive_address, btc_sign_psbt};
pub use grin::{
    grin_adaptor_complete, grin_adaptor_extract_secret, grin_adaptor_partial_sign,
    grin_adaptor_partial_verify, grin_blind_add, grin_blind_sub, grin_blind_sum,
    grin_bullet_proof_create, grin_bullet_proof_rewind, grin_bullet_proof_verify,
    grin_derive_extended_key,
    grin_derive_keys, grin_ext_version, grin_kernel_features_bytes, grin_kernel_sig_msg,
    grin_pedersen_commit, grin_point_add, grin_point_sum, grin_schnorr_aggregate_partials,
    grin_schnorr_final_signature, grin_schnorr_partial_sign, grin_schnorr_partial_verify,
    grin_pubkey_to_commitment, grin_receiver_finalize_i3, grin_receiver_init_i1,
    grin_receiver_round_s2, grin_schnorr_sign, grin_schnorr_verify, grin_secp256k1_public_key,
    grin_sender_blind_excess, grin_sender_finalize_s3, grin_sender_init_s1, grin_sender_round_i2,
    grin_sign_payment_proof, grin_slate_round_trip, grin_slate_summary,
    grin_slate_to_transaction_bytes, grin_slatepack_address, grin_slatepack_address_secret,
    grin_slatepack_armor, grin_slatepack_bin_decode, grin_slatepack_bin_encode_plain,
    grin_slatepack_dearmor, grin_slatepack_decrypt, grin_slatepack_encrypt,
    grin_slatepack_pack_encrypted, grin_slatepack_pack_plain, grin_slatepack_unpack,
    grin_slatepack_unpack_with_secret, grin_verify_payment_proof,
};
pub use keys::derive_key_image;
pub use signing::{compute_key_image, derive_output_key_image, estimate_fee, sign_transaction};
pub use transaction::parse_tx;

/// Simple test function to verify WASM is loaded.
#[wasm_bindgen]
pub fn test() -> String {
    "smirk-wasm ready".to_string()
}

/// Get the library version.
#[wasm_bindgen]
pub fn version() -> String {
    // Include build tag to verify new version is loaded
    // wow25: RctPrunable stores explicit rct_type for proper type 8 serialization
    format!("{}-wow25", env!("CARGO_PKG_VERSION"))
}
