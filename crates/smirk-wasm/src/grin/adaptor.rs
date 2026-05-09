//! Schnorr adaptor signatures — v0.4 atomic-swap building block.
//!
//! An adaptor signature is an "incomplete" Schnorr signature whose
//! completion requires a secret scalar `t`. A verifier can confirm that
//! *if* `t` is revealed, completion would yield a valid signature, without
//! knowing `t` themselves. Used as cryptographic glue between two chains
//! in atomic swaps: revealing `t` on one chain lets the counterparty
//! complete their signature on the other.
//!
//! See `crates/grin-ext/src/schnorr.rs` for the underlying primitives.

use wasm_bindgen::prelude::*;

/// Produce an adaptor partial signature.
#[wasm_bindgen]
pub fn grin_adaptor_partial_sign(
    secret_key_hex: &str,
    secret_nonce_hex: &str,
    public_nonce_total_no_t_hex: &str,
    public_key_total_hex: &str,
    adaptor_point_t_hex: &str,
    message_hex: &str,
) -> Result<String, JsValue> {
    let mut sk = [0u8; 32];
    hex::decode_to_slice(secret_key_hex, &mut sk)
        .map_err(|e| JsValue::from_str(&format!("invalid secret_key_hex: {e}")))?;
    let mut nonce = [0u8; 32];
    hex::decode_to_slice(secret_nonce_hex, &mut nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid secret_nonce_hex: {e}")))?;
    let mut r_total = [0u8; 33];
    hex::decode_to_slice(public_nonce_total_no_t_hex, &mut r_total)
        .map_err(|e| JsValue::from_str(&format!("invalid public_nonce_total_no_t_hex: {e}")))?;
    let mut p_total = [0u8; 33];
    hex::decode_to_slice(public_key_total_hex, &mut p_total)
        .map_err(|e| JsValue::from_str(&format!("invalid public_key_total_hex: {e}")))?;
    let mut t_point = [0u8; 33];
    hex::decode_to_slice(adaptor_point_t_hex, &mut t_point)
        .map_err(|e| JsValue::from_str(&format!("invalid adaptor_point_t_hex: {e}")))?;
    let mut msg = [0u8; 32];
    hex::decode_to_slice(message_hex, &mut msg)
        .map_err(|e| JsValue::from_str(&format!("invalid message_hex: {e}")))?;

    let s = grin_ext::adaptor_partial_sign(&sk, &nonce, &r_total, &p_total, &t_point, &msg)
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(s))
}

/// Verify an adaptor partial signature. Returns true if the partial WILL
/// complete to a valid normal partial when combined with the adaptor
/// secret `t` (where T = t·G).
#[wasm_bindgen]
pub fn grin_adaptor_partial_verify(
    adaptor_partial_s_hex: &str,
    public_nonce_i_hex: &str,
    public_key_i_hex: &str,
    public_nonce_total_no_t_hex: &str,
    public_key_total_hex: &str,
    adaptor_point_t_hex: &str,
    message_hex: &str,
) -> Result<bool, JsValue> {
    let mut s = [0u8; 32];
    hex::decode_to_slice(adaptor_partial_s_hex, &mut s)
        .map_err(|e| JsValue::from_str(&format!("invalid adaptor_partial_s_hex: {e}")))?;
    let mut r_i = [0u8; 33];
    hex::decode_to_slice(public_nonce_i_hex, &mut r_i)
        .map_err(|e| JsValue::from_str(&format!("invalid public_nonce_i_hex: {e}")))?;
    let mut p_i = [0u8; 33];
    hex::decode_to_slice(public_key_i_hex, &mut p_i)
        .map_err(|e| JsValue::from_str(&format!("invalid public_key_i_hex: {e}")))?;
    let mut r_total = [0u8; 33];
    hex::decode_to_slice(public_nonce_total_no_t_hex, &mut r_total)
        .map_err(|e| JsValue::from_str(&format!("invalid public_nonce_total_no_t_hex: {e}")))?;
    let mut p_total = [0u8; 33];
    hex::decode_to_slice(public_key_total_hex, &mut p_total)
        .map_err(|e| JsValue::from_str(&format!("invalid public_key_total_hex: {e}")))?;
    let mut t_point = [0u8; 33];
    hex::decode_to_slice(adaptor_point_t_hex, &mut t_point)
        .map_err(|e| JsValue::from_str(&format!("invalid adaptor_point_t_hex: {e}")))?;
    let mut msg = [0u8; 32];
    hex::decode_to_slice(message_hex, &mut msg)
        .map_err(|e| JsValue::from_str(&format!("invalid message_hex: {e}")))?;

    grin_ext::adaptor_partial_verify(&s, &r_i, &p_i, &r_total, &p_total, &t_point, &msg)
        .map_err(|e| JsValue::from_str(&e))
}

/// Complete an adaptor partial with the adaptor secret `t`.
/// Returns the completed partial scalar (32 bytes hex).
#[wasm_bindgen]
pub fn grin_adaptor_complete(
    adaptor_partial_s_hex: &str,
    adaptor_secret_t_hex: &str,
) -> Result<String, JsValue> {
    let mut s_prime = [0u8; 32];
    hex::decode_to_slice(adaptor_partial_s_hex, &mut s_prime)
        .map_err(|e| JsValue::from_str(&format!("invalid adaptor_partial_s_hex: {e}")))?;
    let mut t = [0u8; 32];
    hex::decode_to_slice(adaptor_secret_t_hex, &mut t)
        .map_err(|e| JsValue::from_str(&format!("invalid adaptor_secret_t_hex: {e}")))?;
    let s = grin_ext::complete_adaptor(&s_prime, &t).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(s))
}

/// Extract the adaptor secret `t` from a completed partial signature given
/// the original adaptor partial. Used by atomic-swap watchers — once a
/// counterparty publishes the completed signature on chain, the watcher
/// recovers `t` and uses it to claim their side of the swap.
#[wasm_bindgen]
pub fn grin_adaptor_extract_secret(
    completed_partial_s_hex: &str,
    adaptor_partial_s_hex: &str,
) -> Result<String, JsValue> {
    let mut s = [0u8; 32];
    hex::decode_to_slice(completed_partial_s_hex, &mut s)
        .map_err(|e| JsValue::from_str(&format!("invalid completed_partial_s_hex: {e}")))?;
    let mut s_prime = [0u8; 32];
    hex::decode_to_slice(adaptor_partial_s_hex, &mut s_prime)
        .map_err(|e| JsValue::from_str(&format!("invalid adaptor_partial_s_hex: {e}")))?;
    let t = grin_ext::extract_adaptor_secret(&s, &s_prime).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(t))
}
