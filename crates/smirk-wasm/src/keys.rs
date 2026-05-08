//! Key derivation functions.

use wasm_bindgen::prelude::*;

use crate::result::WasmResult;

/// Derive a key image from output public key and spend key.
///
/// This is used to check if an output has been spent. The key image is:
/// `(spend_key + key_offset) * Hp(output_public_key)`
/// where Hp is hash-to-point.
///
/// # Arguments
/// * `output_public_key_hex` - The output's public key (32 bytes, hex)
/// * `spend_key_hex` - The wallet's private spend key (32 bytes, hex)
/// * `key_offset_hex` - The key offset for this output (32 bytes, hex)
///
/// # Returns
/// JSON with the key image hex or error.
#[wasm_bindgen]
pub fn derive_key_image(
    output_public_key_hex: &str,
    spend_key_hex: &str,
    key_offset_hex: &str,
) -> String {
    use curve25519_dalek::scalar::Scalar as DScalar;
    use monero_oxide::ed25519::{CompressedPoint, Point};

    // Parse output public key
    let output_key_bytes: [u8; 32] = match hex::decode(output_public_key_hex)
        .ok()
        .and_then(|v| v.try_into().ok())
    {
        Some(b) => b,
        None => return WasmResult::err("Invalid output public key hex"),
    };

    // Parse spend key
    let spend_key_bytes: [u8; 32] = match hex::decode(spend_key_hex)
        .ok()
        .and_then(|v| v.try_into().ok())
    {
        Some(b) => b,
        None => return WasmResult::err("Invalid spend key hex"),
    };

    // Parse key offset
    let key_offset_bytes: [u8; 32] = match hex::decode(key_offset_hex)
        .ok()
        .and_then(|v| v.try_into().ok())
    {
        Some(b) => b,
        None => return WasmResult::err("Invalid key offset hex"),
    };

    // Decompress output public key
    let compressed = CompressedPoint::from(output_key_bytes);
    let output_key: Point = match compressed.decompress() {
        Some(p) => p,
        None => return WasmResult::err("Invalid output public key point"),
    };

    // Create scalars using dalek directly
    let spend_scalar = match DScalar::from_canonical_bytes(spend_key_bytes).into_option() {
        Some(s) => s,
        None => return WasmResult::err("Invalid spend key scalar"),
    };
    let offset_scalar = match DScalar::from_canonical_bytes(key_offset_bytes).into_option() {
        Some(s) => s,
        None => return WasmResult::err("Invalid key offset scalar"),
    };

    // Compute input key: spend_key + key_offset
    let input_key = spend_scalar + offset_scalar;

    // Compute key image: input_key * Hp(output_key)
    let hp: curve25519_dalek::EdwardsPoint =
        Point::biased_hash(output_key.compress().to_bytes()).into();
    let key_image = input_key * hp;

    WasmResult::ok(hex::encode(key_image.compress().to_bytes()))
}
