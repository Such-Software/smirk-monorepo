//! Transaction wire-format assembly — finalized slate → broadcastable TX.

use wasm_bindgen::prelude::*;

/// Convert a finalized S3 slate + the sender's inputs/change + the
/// aggregated kernel signature into broadcastable Grin transaction bytes.
///
/// Inputs are encoded as concatenated `(features_byte || 33-byte commit)`
/// pairs in `inputs_concat_hex` — i.e. each input is 34 hex bytes long
/// (68 hex chars).
///
/// Outputs are encoded as a JSON array string: `[{"f": 0, "c": "...",
/// "p": "..."}]` where each entry has features byte, 33-byte commitment
/// hex, and rangeproof hex.
///
/// Returns the full TX as hex (typically 1+ KB).
#[wasm_bindgen]
pub fn grin_slate_to_transaction_bytes(
    s3_slate_json: &str,
    sender_inputs_concat_hex: &str,
    sender_change_outputs_json: &str,
    aggregated_kernel_signature_hex: &str,
) -> Result<String, JsValue> {
    let s3 = grin_ext::slate::parse_slate_v4(s3_slate_json).map_err(|e| JsValue::from_str(&e))?;

    // Parse inputs: concatenated (features_byte || 33-byte commit).
    if sender_inputs_concat_hex.len() % 68 != 0 {
        return Err(JsValue::from_str(&format!(
            "inputs hex length must be a multiple of 68 (one input = 1 feat + 33 commit = 34 bytes); got {}",
            sender_inputs_concat_hex.len()
        )));
    }
    let n_inputs = sender_inputs_concat_hex.len() / 68;
    let mut sender_inputs = Vec::with_capacity(n_inputs);
    for i in 0..n_inputs {
        let chunk = &sender_inputs_concat_hex[i * 68..(i + 1) * 68];
        let mut bytes = [0u8; 34];
        hex::decode_to_slice(chunk, &mut bytes)
            .map_err(|e| JsValue::from_str(&format!("invalid input #{i} hex: {e}")))?;
        let mut commitment = [0u8; 33];
        commitment.copy_from_slice(&bytes[1..]);
        sender_inputs.push(grin_ext::TxInput {
            features: bytes[0],
            commitment,
        });
    }

    // Parse change outputs from JSON array.
    let change_array: serde_json::Value = serde_json::from_str(sender_change_outputs_json)
        .map_err(|e| JsValue::from_str(&format!("invalid sender_change_outputs_json: {e}")))?;
    let mut sender_change_outputs = Vec::new();
    if let Some(arr) = change_array.as_array() {
        for (i, entry) in arr.iter().enumerate() {
            let f = entry["f"].as_u64().ok_or_else(|| {
                JsValue::from_str(&format!("change_outputs[{i}].f missing or not u8"))
            })? as u8;
            let c_hex = entry["c"]
                .as_str()
                .ok_or_else(|| JsValue::from_str(&format!("change_outputs[{i}].c missing")))?;
            let p_hex = entry["p"]
                .as_str()
                .ok_or_else(|| JsValue::from_str(&format!("change_outputs[{i}].p missing")))?;
            let mut commitment = [0u8; 33];
            hex::decode_to_slice(c_hex, &mut commitment)
                .map_err(|e| JsValue::from_str(&format!("change_outputs[{i}].c invalid: {e}")))?;
            let rangeproof = hex::decode(p_hex)
                .map_err(|e| JsValue::from_str(&format!("change_outputs[{i}].p invalid: {e}")))?;
            sender_change_outputs.push(grin_ext::TxOutput {
                features: f,
                commitment,
                rangeproof,
            });
        }
    } else {
        return Err(JsValue::from_str("sender_change_outputs_json must be a JSON array"));
    }

    let mut sig = [0u8; 64];
    hex::decode_to_slice(aggregated_kernel_signature_hex, &mut sig).map_err(|e| {
        JsValue::from_str(&format!("invalid aggregated_kernel_signature_hex: {e}"))
    })?;

    let tx_bytes = grin_ext::slate_to_transaction_bytes(&grin_ext::BuildTransactionParams {
        s3_slate: s3,
        sender_inputs,
        sender_change_outputs,
        aggregated_kernel_signature: sig,
    })
    .map_err(|e| JsValue::from_str(&e))?;

    Ok(hex::encode(tx_bytes))
}

/// Convert a 33-byte compressed secp256k1 public key (0x02/0x03 prefix)
/// to a 33-byte Grin Pedersen commitment (0x08/0x09 prefix). Useful for
/// constructing the kernel excess from `P_total`.
#[wasm_bindgen]
pub fn grin_pubkey_to_commitment(pubkey_hex: &str) -> Result<String, JsValue> {
    let mut pk = [0u8; 33];
    hex::decode_to_slice(pubkey_hex, &mut pk)
        .map_err(|e| JsValue::from_str(&format!("invalid pubkey_hex: {e}")))?;
    let commit = grin_ext::pubkey_to_commitment(&pk).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(commit))
}
