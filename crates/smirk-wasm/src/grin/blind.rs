//! Blinding-factor scalar arithmetic over the secp256k1 curve order.
//!
//! Used when composing input/output blinding factors with the kernel
//! offset to produce the sender-side blind excess. Scalars are passed in
//! and out as 32-byte hex (64 chars).

use wasm_bindgen::prelude::*;

/// Sum N 32-byte scalars modulo the secp256k1 curve order.
/// `scalars_concat_hex` is the concatenation of N 64-hex-char scalars.
#[wasm_bindgen]
pub fn grin_blind_sum(scalars_concat_hex: &str) -> Result<String, JsValue> {
    if scalars_concat_hex.len() % 64 != 0 {
        return Err(JsValue::from_str(&format!(
            "scalars length must be a multiple of 64 hex chars; got {}",
            scalars_concat_hex.len()
        )));
    }
    let n = scalars_concat_hex.len() / 64;
    let mut scalars = Vec::with_capacity(n);
    for i in 0..n {
        let mut s = [0u8; 32];
        hex::decode_to_slice(&scalars_concat_hex[i * 64..(i + 1) * 64], &mut s)
            .map_err(|e| JsValue::from_str(&format!("invalid scalar at index {i}: {e}")))?;
        scalars.push(s);
    }
    Ok(hex::encode(grin_ext::blind::sum(&scalars)))
}

/// Compute `(a + b) mod n` over 32-byte scalars.
#[wasm_bindgen]
pub fn grin_blind_add(a_hex: &str, b_hex: &str) -> Result<String, JsValue> {
    let mut a = [0u8; 32];
    hex::decode_to_slice(a_hex, &mut a)
        .map_err(|e| JsValue::from_str(&format!("invalid a_hex: {e}")))?;
    let mut b = [0u8; 32];
    hex::decode_to_slice(b_hex, &mut b)
        .map_err(|e| JsValue::from_str(&format!("invalid b_hex: {e}")))?;
    Ok(hex::encode(grin_ext::blind::add(&a, &b)))
}

/// Compute `(a - b) mod n` over 32-byte scalars.
#[wasm_bindgen]
pub fn grin_blind_sub(a_hex: &str, b_hex: &str) -> Result<String, JsValue> {
    let mut a = [0u8; 32];
    hex::decode_to_slice(a_hex, &mut a)
        .map_err(|e| JsValue::from_str(&format!("invalid a_hex: {e}")))?;
    let mut b = [0u8; 32];
    hex::decode_to_slice(b_hex, &mut b)
        .map_err(|e| JsValue::from_str(&format!("invalid b_hex: {e}")))?;
    Ok(hex::encode(grin_ext::blind::sub(&a, &b)))
}

/// Compute the sender-side blind excess for a Grin transaction.
/// Inputs and sender_outputs are concatenated 32-byte scalars (as hex).
#[wasm_bindgen]
pub fn grin_sender_blind_excess(
    input_blinds_concat_hex: &str,
    sender_output_blinds_concat_hex: &str,
    kernel_offset_hex: &str,
) -> Result<String, JsValue> {
    let split = |concat: &str, name: &str| -> Result<Vec<[u8; 32]>, JsValue> {
        if concat.len() % 64 != 0 {
            return Err(JsValue::from_str(&format!(
                "{name} length must be a multiple of 64 hex chars; got {}",
                concat.len()
            )));
        }
        let n = concat.len() / 64;
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let mut s = [0u8; 32];
            hex::decode_to_slice(&concat[i * 64..(i + 1) * 64], &mut s)
                .map_err(|e| JsValue::from_str(&format!("invalid {name} index {i}: {e}")))?;
            out.push(s);
        }
        Ok(out)
    };
    let inputs = split(input_blinds_concat_hex, "input_blinds")?;
    let outputs = split(sender_output_blinds_concat_hex, "sender_output_blinds")?;
    let mut offset = [0u8; 32];
    hex::decode_to_slice(kernel_offset_hex, &mut offset)
        .map_err(|e| JsValue::from_str(&format!("invalid kernel_offset_hex: {e}")))?;
    Ok(hex::encode(grin_ext::blind::sender_blind_excess(
        &inputs, &outputs, &offset,
    )))
}
