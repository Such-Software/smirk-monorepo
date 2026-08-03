//! Multi-party Schnorr aggregation (Grin slate signing).
//!
//! Each participant produces a partial signature; partials aggregate into
//! a final 64-byte signature that verifies against the aggregate public
//! key as if it were a single-signer signature.

use wasm_bindgen::prelude::*;

/// Add two compressed secp256k1 public keys via curve point addition.
/// Inputs are 33-byte hex (66 chars), output is 33-byte hex.
#[wasm_bindgen]
pub fn grin_point_add(a_hex: &str, b_hex: &str) -> Result<String, JsValue> {
    let mut a = [0u8; 33];
    hex::decode_to_slice(a_hex, &mut a)
        .map_err(|e| JsValue::from_str(&format!("invalid a_hex: {e}")))?;
    let mut b = [0u8; 33];
    hex::decode_to_slice(b_hex, &mut b)
        .map_err(|e| JsValue::from_str(&format!("invalid b_hex: {e}")))?;
    let sum = grin_ext::point_add(&a, &b).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(sum))
}

/// Sum N compressed pubkeys. `points_concat_hex` is the concatenation of
/// 33-byte (66-hex-char) pubkeys. Returns the sum as 33-byte hex.
#[wasm_bindgen]
pub fn grin_point_sum(points_concat_hex: &str) -> Result<String, JsValue> {
    if !points_concat_hex.len().is_multiple_of(66) {
        return Err(JsValue::from_str(&format!(
            "concatenated pubkeys length must be a multiple of 66 hex chars; got {}",
            points_concat_hex.len()
        )));
    }
    let n = points_concat_hex.len() / 66;
    let mut points = Vec::with_capacity(n);
    for i in 0..n {
        let mut p = [0u8; 33];
        hex::decode_to_slice(&points_concat_hex[i * 66..(i + 1) * 66], &mut p)
            .map_err(|e| JsValue::from_str(&format!("invalid pubkey at index {i}: {e}")))?;
        points.push(p);
    }
    let sum = grin_ext::point_sum(&points).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(sum))
}

/// Produce a partial Schnorr signature for one participant in a multi-party
/// signing ceremony.
///
/// All `_hex` arguments are hex strings:
/// - `secret_key_hex` / `secret_nonce_hex`: 32-byte scalars (64 hex chars)
/// - `public_nonce_total_hex` / `public_key_total_hex`: 33-byte compressed
///    pubkeys (66 hex chars), each the SUM of all participants' values
/// - `message_hex`: 32-byte digest
///
/// Returns the partial scalar `s_i` as 32-byte hex.
#[wasm_bindgen]
pub fn grin_schnorr_partial_sign(
    secret_key_hex: &str,
    secret_nonce_hex: &str,
    public_nonce_total_hex: &str,
    public_key_total_hex: &str,
    message_hex: &str,
) -> Result<String, JsValue> {
    let mut sk = [0u8; 32];
    hex::decode_to_slice(secret_key_hex, &mut sk)
        .map_err(|e| JsValue::from_str(&format!("invalid secret_key_hex: {e}")))?;
    let mut nonce = [0u8; 32];
    hex::decode_to_slice(secret_nonce_hex, &mut nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid secret_nonce_hex: {e}")))?;
    let mut r_total = [0u8; 33];
    hex::decode_to_slice(public_nonce_total_hex, &mut r_total)
        .map_err(|e| JsValue::from_str(&format!("invalid public_nonce_total_hex: {e}")))?;
    let mut p_total = [0u8; 33];
    hex::decode_to_slice(public_key_total_hex, &mut p_total)
        .map_err(|e| JsValue::from_str(&format!("invalid public_key_total_hex: {e}")))?;
    let mut msg = [0u8; 32];
    hex::decode_to_slice(message_hex, &mut msg)
        .map_err(|e| JsValue::from_str(&format!("invalid message_hex: {e}")))?;

    let partial = grin_ext::partial_sign(&sk, &nonce, &r_total, &p_total, &msg)
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(partial))
}

/// Verify a partial Schnorr signature (one participant's contribution).
#[wasm_bindgen]
pub fn grin_schnorr_partial_verify(
    partial_s_hex: &str,
    public_nonce_i_hex: &str,
    public_key_i_hex: &str,
    public_nonce_total_hex: &str,
    public_key_total_hex: &str,
    message_hex: &str,
) -> Result<bool, JsValue> {
    let mut partial = [0u8; 32];
    hex::decode_to_slice(partial_s_hex, &mut partial)
        .map_err(|e| JsValue::from_str(&format!("invalid partial_s_hex: {e}")))?;
    let mut r_i = [0u8; 33];
    hex::decode_to_slice(public_nonce_i_hex, &mut r_i)
        .map_err(|e| JsValue::from_str(&format!("invalid public_nonce_i_hex: {e}")))?;
    let mut p_i = [0u8; 33];
    hex::decode_to_slice(public_key_i_hex, &mut p_i)
        .map_err(|e| JsValue::from_str(&format!("invalid public_key_i_hex: {e}")))?;
    let mut r_total = [0u8; 33];
    hex::decode_to_slice(public_nonce_total_hex, &mut r_total)
        .map_err(|e| JsValue::from_str(&format!("invalid public_nonce_total_hex: {e}")))?;
    let mut p_total = [0u8; 33];
    hex::decode_to_slice(public_key_total_hex, &mut p_total)
        .map_err(|e| JsValue::from_str(&format!("invalid public_key_total_hex: {e}")))?;
    let mut msg = [0u8; 32];
    hex::decode_to_slice(message_hex, &mut msg)
        .map_err(|e| JsValue::from_str(&format!("invalid message_hex: {e}")))?;

    grin_ext::partial_verify(&partial, &r_i, &p_i, &r_total, &p_total, &msg)
        .map_err(|e| JsValue::from_str(&e))
}

/// Aggregate N partial scalars into `s_total = s_1 + s_2 + ... + s_n`
/// (mod curve order). `partials_concat_hex` is the concatenation of
/// 32-byte (64-hex-char) scalars. Returns the aggregate as 32-byte hex.
#[wasm_bindgen]
pub fn grin_schnorr_aggregate_partials(partials_concat_hex: &str) -> Result<String, JsValue> {
    if !partials_concat_hex.len().is_multiple_of(64) {
        return Err(JsValue::from_str(&format!(
            "concatenated partials length must be a multiple of 64 hex chars; got {}",
            partials_concat_hex.len()
        )));
    }
    let n = partials_concat_hex.len() / 64;
    let mut partials = Vec::with_capacity(n);
    for i in 0..n {
        let mut p = [0u8; 32];
        hex::decode_to_slice(&partials_concat_hex[i * 64..(i + 1) * 64], &mut p)
            .map_err(|e| JsValue::from_str(&format!("invalid partial at index {i}: {e}")))?;
        partials.push(p);
    }
    let sum = grin_ext::aggregate_partials(&partials).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(sum))
}

/// Build a final 64-byte aggregate Schnorr signature from `R_total` and the
/// aggregated scalar `s_total`.
///
/// The result verifies as a single-signer signature against the aggregate
/// public key `P_total`; pass it through the existing `grin_schnorr_verify`
/// with `public_key_hex = P_total`.
#[wasm_bindgen]
pub fn grin_schnorr_final_signature(
    public_nonce_total_hex: &str,
    aggregate_s_hex: &str,
) -> Result<String, JsValue> {
    let mut r_total = [0u8; 33];
    hex::decode_to_slice(public_nonce_total_hex, &mut r_total)
        .map_err(|e| JsValue::from_str(&format!("invalid public_nonce_total_hex: {e}")))?;
    let mut s = [0u8; 32];
    hex::decode_to_slice(aggregate_s_hex, &mut s)
        .map_err(|e| JsValue::from_str(&format!("invalid aggregate_s_hex: {e}")))?;

    let sig = grin_ext::final_signature(&r_total, &s);
    Ok(sig.to_hex())
}
