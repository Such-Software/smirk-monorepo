//! Single-signer Schnorr signatures over secp256k1 (Grin style).
//!
//! Multi-party aggregation lives in [`crate::grin::multiparty`]; adaptor
//! variants live in [`crate::grin::adaptor`].

use wasm_bindgen::prelude::*;

/// Sign a 32-byte message hash with a Grin-style Schnorr signature.
///
/// `secret_key_hex` and `secret_nonce_hex` are 32-byte scalars (64 hex chars).
/// `message_hex` is the 32-byte message digest (64 hex chars).
///
/// Returns the 64-byte compact signature as 128 hex chars.
///
/// **The caller is responsible for ensuring the secret_nonce is fresh**
/// (CSPRNG-derived, never-reused). Reusing a nonce across messages with the
/// same secret key reveals the secret key.
#[wasm_bindgen]
pub fn grin_schnorr_sign(
    secret_key_hex: &str,
    secret_nonce_hex: &str,
    message_hex: &str,
) -> Result<String, JsValue> {
    let mut sk = [0u8; 32];
    hex::decode_to_slice(secret_key_hex, &mut sk)
        .map_err(|e| JsValue::from_str(&format!("invalid secret_key_hex: {e}")))?;

    let mut nonce = [0u8; 32];
    hex::decode_to_slice(secret_nonce_hex, &mut nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid secret_nonce_hex: {e}")))?;

    let mut msg = [0u8; 32];
    hex::decode_to_slice(message_hex, &mut msg)
        .map_err(|e| JsValue::from_str(&format!("invalid message_hex: {e}")))?;

    let sig = grin_ext::sign_with_nonce(&sk, &nonce, &msg).map_err(|e| JsValue::from_str(&e))?;
    Ok(sig.to_hex())
}

/// Verify a Grin-style Schnorr signature.
///
/// `signature_hex` is 64 bytes (128 hex chars). `message_hex` is the 32-byte
/// message digest. `public_key_hex` is the 33-byte compressed secp256k1
/// public key.
///
/// Returns `true` if the signature is valid, `false` otherwise. Throws on
/// malformed inputs.
#[wasm_bindgen]
pub fn grin_schnorr_verify(
    signature_hex: &str,
    message_hex: &str,
    public_key_hex: &str,
) -> Result<bool, JsValue> {
    let mut sig_bytes = [0u8; 64];
    hex::decode_to_slice(signature_hex, &mut sig_bytes)
        .map_err(|e| JsValue::from_str(&format!("invalid signature_hex: {e}")))?;
    let sig = grin_ext::Signature::from_bytes(sig_bytes);

    let mut msg = [0u8; 32];
    hex::decode_to_slice(message_hex, &mut msg)
        .map_err(|e| JsValue::from_str(&format!("invalid message_hex: {e}")))?;

    let mut pk = [0u8; 33];
    hex::decode_to_slice(public_key_hex, &mut pk)
        .map_err(|e| JsValue::from_str(&format!("invalid public_key_hex: {e}")))?;

    grin_ext::schnorr_verify(&sig, &msg, &pk).map_err(|e| JsValue::from_str(&e))
}
