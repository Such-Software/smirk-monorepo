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
pub use grin::{
    grin_derive_extended_key, grin_derive_keys, grin_ext_version, grin_schnorr_sign,
    grin_schnorr_verify, grin_secp256k1_public_key, grin_slatepack_address,
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
