//! Pedersen commitments and Bulletproof range proofs.
//!
//! Backed by the vendored `crates/secp256k1zkp/` (Grin's
//! `grin_secp256k1zkp` v0.7.15, patched for wasm32). This is **BP**, not
//! BP+ — Grin never adopted Bulletproofs+.

use wasm_bindgen::prelude::*;

/// Create a Pedersen commitment to `(value, blinding_factor)`.
///
/// `blinding_factor_hex` is 32 bytes (64 hex chars).
/// Returns 33 bytes (66 hex chars) — the commitment.
#[wasm_bindgen]
pub fn grin_pedersen_commit(value: u64, blinding_factor_hex: &str) -> Result<String, JsValue> {
    let mut blind = [0u8; 32];
    hex::decode_to_slice(blinding_factor_hex, &mut blind)
        .map_err(|e| JsValue::from_str(&format!("invalid blinding_factor_hex: {e}")))?;
    let commit = grin_ext::pedersen_commit(value, &blind).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(commit))
}

/// Create a Bulletproof range proof.
///
/// All `_hex` arguments are 32-byte scalars (64 hex chars). `value` is in
/// nanogrin. `rewind_nonce` will allow the receiver to recover the value.
/// `private_nonce` should be a fresh CSPRNG-derived secret known only to
/// the prover.
///
/// Returns the proof bytes as hex (typically ~676 bytes / 1352 hex chars
/// for a single 64-bit range).
#[wasm_bindgen]
pub fn grin_bullet_proof_create(
    value: u64,
    blinding_factor_hex: &str,
    rewind_nonce_hex: &str,
    private_nonce_hex: &str,
) -> Result<String, JsValue> {
    let mut blind = [0u8; 32];
    hex::decode_to_slice(blinding_factor_hex, &mut blind)
        .map_err(|e| JsValue::from_str(&format!("invalid blinding_factor_hex: {e}")))?;
    let mut rewind = [0u8; 32];
    hex::decode_to_slice(rewind_nonce_hex, &mut rewind)
        .map_err(|e| JsValue::from_str(&format!("invalid rewind_nonce_hex: {e}")))?;
    let mut private = [0u8; 32];
    hex::decode_to_slice(private_nonce_hex, &mut private)
        .map_err(|e| JsValue::from_str(&format!("invalid private_nonce_hex: {e}")))?;

    let proof = grin_ext::bullet_proof_create(value, &blind, &rewind, &private)
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(proof))
}

/// Verify a Bulletproof against a Pedersen commitment.
///
/// `commit_hex` is the 33-byte commitment (66 hex chars).
/// `proof_hex` is the variable-length proof bytes (hex).
/// Returns `true` if valid, `false` if invalid.
#[wasm_bindgen]
pub fn grin_bullet_proof_verify(commit_hex: &str, proof_hex: &str) -> Result<bool, JsValue> {
    let mut commit = [0u8; 33];
    hex::decode_to_slice(commit_hex, &mut commit)
        .map_err(|e| JsValue::from_str(&format!("invalid commit_hex: {e}")))?;
    let proof_bytes = hex::decode(proof_hex)
        .map_err(|e| JsValue::from_str(&format!("invalid proof_hex: {e}")))?;
    grin_ext::bullet_proof_verify(&commit, &proof_bytes).map_err(|e| JsValue::from_str(&e))
}

/// Rewind a Bulletproof, recovering the committed value (and a derived
/// blinding factor for the recipient to use later).
///
/// Returns JSON: `{ "value": "...", "blinding_factor_hex": "..." }` on
/// successful rewind, or `null` if the nonce doesn't match the proof.
#[wasm_bindgen]
pub fn grin_bullet_proof_rewind(
    commit_hex: &str,
    rewind_nonce_hex: &str,
    proof_hex: &str,
) -> Result<String, JsValue> {
    let mut commit = [0u8; 33];
    hex::decode_to_slice(commit_hex, &mut commit)
        .map_err(|e| JsValue::from_str(&format!("invalid commit_hex: {e}")))?;
    let mut nonce = [0u8; 32];
    hex::decode_to_slice(rewind_nonce_hex, &mut nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid rewind_nonce_hex: {e}")))?;
    let proof_bytes = hex::decode(proof_hex)
        .map_err(|e| JsValue::from_str(&format!("invalid proof_hex: {e}")))?;

    match grin_ext::bullet_proof_rewind(&commit, &nonce, &proof_bytes)
        .map_err(|e| JsValue::from_str(&e))?
    {
        Some((value, blinding)) => Ok(format!(
            r#"{{"value":"{}","blinding_factor_hex":"{}"}}"#,
            value,
            hex::encode(blinding)
        )),
        None => Ok("null".to_string()),
    }
}
