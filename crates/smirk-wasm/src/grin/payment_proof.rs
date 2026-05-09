//! Payment proofs — the receiver's ed25519-signed receipt over `(amount,
//! kernel_commitment, sender_address)`.
//!
//! Useful for dispute resolution, audit trails, escrow, and merchant flows.
//! The receiver's slatepack address (ed25519 pubkey) signs; the sender
//! verifies offline. See `crates/grin-ext/src/payment_proof.rs` for the
//! exact 73-byte message format.

use wasm_bindgen::prelude::*;

/// Sign a Grin payment proof. Returns the 64-byte ed25519 signature.
///
/// `kernel_commitment_hex` is the 33-byte kernel excess commitment from
/// the finalized transaction. `sender_address_hex` is the sender's
/// slatepack-address 32-byte ed25519 pubkey (decoded from bech32).
/// `receiver_secret_hex` is the receiver's ed25519 secret seed.
#[wasm_bindgen]
pub fn grin_sign_payment_proof(
    amount: u64,
    kernel_commitment_hex: &str,
    sender_address_hex: &str,
    receiver_secret_hex: &str,
) -> Result<String, JsValue> {
    let mut commit = [0u8; 33];
    hex::decode_to_slice(kernel_commitment_hex, &mut commit)
        .map_err(|e| JsValue::from_str(&format!("invalid kernel_commitment_hex: {e}")))?;
    let mut sender = [0u8; 32];
    hex::decode_to_slice(sender_address_hex, &mut sender)
        .map_err(|e| JsValue::from_str(&format!("invalid sender_address_hex: {e}")))?;
    let mut secret = [0u8; 32];
    hex::decode_to_slice(receiver_secret_hex, &mut secret)
        .map_err(|e| JsValue::from_str(&format!("invalid receiver_secret_hex: {e}")))?;
    let sig = grin_ext::sign_payment_proof(amount, &commit, &sender, &secret);
    Ok(hex::encode(sig))
}

/// Verify a Grin payment proof. Returns true if the receiver's ed25519
/// signature attests to the given (amount, kernel commitment, sender
/// address) tuple.
#[wasm_bindgen]
pub fn grin_verify_payment_proof(
    amount: u64,
    kernel_commitment_hex: &str,
    sender_address_hex: &str,
    receiver_address_hex: &str,
    signature_hex: &str,
) -> Result<bool, JsValue> {
    let mut commit = [0u8; 33];
    hex::decode_to_slice(kernel_commitment_hex, &mut commit)
        .map_err(|e| JsValue::from_str(&format!("invalid kernel_commitment_hex: {e}")))?;
    let mut sender = [0u8; 32];
    hex::decode_to_slice(sender_address_hex, &mut sender)
        .map_err(|e| JsValue::from_str(&format!("invalid sender_address_hex: {e}")))?;
    let mut receiver = [0u8; 32];
    hex::decode_to_slice(receiver_address_hex, &mut receiver)
        .map_err(|e| JsValue::from_str(&format!("invalid receiver_address_hex: {e}")))?;
    let mut sig = [0u8; 64];
    hex::decode_to_slice(signature_hex, &mut sig)
        .map_err(|e| JsValue::from_str(&format!("invalid signature_hex: {e}")))?;
    grin_ext::verify_payment_proof(amount, &commit, &sender, &receiver, &sig)
        .map_err(|e| JsValue::from_str(&e))
}
