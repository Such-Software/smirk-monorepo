//! Kernel features serialization + signing-message hash.

use wasm_bindgen::prelude::*;

use super::build_kernel_features;

/// Compute the 32-byte BLAKE2b message that should be Schnorr-signed for a
/// kernel of the given type.
///
/// `kind` selects the variant: `"plain"`, `"coinbase"`, `"height_locked"`,
/// or `"nrd"`. `fee` is required for everything except coinbase.
/// `lock_height` is required for `height_locked` only. `relative_height` is
/// required for `nrd` only and must be in `[1, 10080]` (one week).
///
/// Returns the message hash as 64 hex chars.
#[wasm_bindgen]
pub fn grin_kernel_sig_msg(
    kind: &str,
    fee: Option<u64>,
    lock_height: Option<u64>,
    relative_height: Option<u32>,
) -> Result<String, JsValue> {
    let features = build_kernel_features(kind, fee, lock_height, relative_height)?;
    let msg = features.sig_msg().map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(msg))
}

/// Serialize kernel features in Grin's v2 protocol wire format.
///
/// Returns the bytes as hex.
#[wasm_bindgen]
pub fn grin_kernel_features_bytes(
    kind: &str,
    fee: Option<u64>,
    lock_height: Option<u64>,
    relative_height: Option<u32>,
) -> Result<String, JsValue> {
    let features = build_kernel_features(kind, fee, lock_height, relative_height)?;
    let bytes = features.to_v2_bytes().map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(bytes))
}
