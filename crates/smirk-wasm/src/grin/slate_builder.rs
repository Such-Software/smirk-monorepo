//! Slate construction ceremonies — standard (S1→S2→S3) and invoice
//! (I1→I2→I3).
//!
//! Each function is a thin JSON wrapper around the corresponding
//! `grin_ext::*` builder. The slate JSON is escaped before embedding into
//! the response so the caller can re-parse it as a JSON string field.

use wasm_bindgen::prelude::*;

use super::build_kernel_features;

// =============================================================================
// Standard flow — sender-driven (S1 → S2 → S3)
// =============================================================================

/// Build the sender's S1 slate.
///
/// Returns JSON: `{ "slate_json": "...", "context": { ... } }` where
/// `slate_json` is a serialized v4 slate ready to send to the receiver,
/// and `context` is the private state the sender must retain to finalize.
///
/// `kernel_kind` is one of `"plain"`, `"coinbase"`, `"height_locked"`, `"nrd"`.
/// `lock_height` and `relative_height` are required for the corresponding
/// kernel kinds. `slate_id` is the caller-supplied slate UUID — pass a
/// fresh v4 UUID string (e.g. `crypto.randomUUID()` in the browser).
#[wasm_bindgen]
pub fn grin_sender_init_s1(
    slate_id: &str,
    amount: u64,
    fee: u64,
    kernel_kind: &str,
    lock_height: Option<u64>,
    relative_height: Option<u32>,
    sender_blind_excess_hex: &str,
    kernel_offset_hex: &str,
    kernel_nonce_hex: &str,
) -> Result<String, JsValue> {
    let kernel_features = build_kernel_features(kernel_kind, Some(fee), lock_height, relative_height)?;

    let mut excess = [0u8; 32];
    hex::decode_to_slice(sender_blind_excess_hex, &mut excess)
        .map_err(|e| JsValue::from_str(&format!("invalid sender_blind_excess_hex: {e}")))?;
    let mut offset = [0u8; 32];
    hex::decode_to_slice(kernel_offset_hex, &mut offset)
        .map_err(|e| JsValue::from_str(&format!("invalid kernel_offset_hex: {e}")))?;
    let mut nonce = [0u8; 32];
    hex::decode_to_slice(kernel_nonce_hex, &mut nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid kernel_nonce_hex: {e}")))?;

    let params = grin_ext::SenderInitParams {
        amount,
        fee,
        kernel_features,
        sender_blind_excess: excess,
        kernel_offset: offset,
        kernel_nonce: nonce,
    };
    let out = grin_ext::sender_init_s1_with_id(&params, slate_id.to_string())
        .map_err(|e| JsValue::from_str(&e))?;

    let slate_json =
        grin_ext::slate::serialize_slate_v4(&out.slate).map_err(|e| JsValue::from_str(&e))?;

    // Escape the slate_json so it can be embedded as a JSON string value.
    let slate_json_escaped = slate_json.replace('\\', r"\\").replace('"', r#"\""#);

    let json = format!(
        r#"{{"slate_json":"{}","context":{{"slate_id":"{}","amount":"{}","fee":"{}","sender_blind_excess_hex":"{}","kernel_offset_hex":"{}","kernel_nonce_hex":"{}"}}}}"#,
        slate_json_escaped,
        out.context.slate_id,
        out.context.amount,
        out.context.fee,
        hex::encode(out.context.sender_blind_excess),
        hex::encode(out.context.kernel_offset),
        hex::encode(out.context.kernel_nonce),
    );
    Ok(json)
}

/// Receiver round: take an S1 slate JSON, produce an S2 slate JSON.
///
/// Returns JSON: `{ "slate_json": "...", "context": { ... } }`. The
/// `context` carries private state the receiver may use later (e.g. to
/// rewind the bulletproof on chain to recover the value).
#[wasm_bindgen]
pub fn grin_receiver_round_s2(
    s1_slate_json: &str,
    receiver_output_blind_hex: &str,
    receiver_kernel_nonce_hex: &str,
    bp_rewind_nonce_hex: &str,
    bp_private_nonce_hex: &str,
) -> Result<String, JsValue> {
    let s1 = grin_ext::slate::parse_slate_v4(s1_slate_json).map_err(|e| JsValue::from_str(&e))?;

    let mut output_blind = [0u8; 32];
    hex::decode_to_slice(receiver_output_blind_hex, &mut output_blind)
        .map_err(|e| JsValue::from_str(&format!("invalid receiver_output_blind_hex: {e}")))?;
    let mut kernel_nonce = [0u8; 32];
    hex::decode_to_slice(receiver_kernel_nonce_hex, &mut kernel_nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid receiver_kernel_nonce_hex: {e}")))?;
    let mut rewind = [0u8; 32];
    hex::decode_to_slice(bp_rewind_nonce_hex, &mut rewind)
        .map_err(|e| JsValue::from_str(&format!("invalid bp_rewind_nonce_hex: {e}")))?;
    let mut priv_nonce = [0u8; 32];
    hex::decode_to_slice(bp_private_nonce_hex, &mut priv_nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid bp_private_nonce_hex: {e}")))?;

    let out = grin_ext::receiver_round_s2(&grin_ext::ReceiverRoundParams {
        s1_slate: s1,
        receiver_output_blind: output_blind,
        receiver_kernel_nonce: kernel_nonce,
        bp_rewind_nonce: rewind,
        bp_private_nonce: priv_nonce,
    })
    .map_err(|e| JsValue::from_str(&e))?;

    let slate_json =
        grin_ext::slate::serialize_slate_v4(&out.slate).map_err(|e| JsValue::from_str(&e))?;
    let slate_json_escaped = slate_json.replace('\\', r"\\").replace('"', r#"\""#);

    let json = format!(
        r#"{{"slate_json":"{}","context":{{"slate_id":"{}","amount":"{}","output_blind_hex":"{}","kernel_nonce_hex":"{}","commitment_hex":"{}","rewind_nonce_hex":"{}"}}}}"#,
        slate_json_escaped,
        out.context.slate_id,
        out.context.amount,
        hex::encode(out.context.output_blind),
        hex::encode(out.context.kernel_nonce),
        hex::encode(out.context.commitment),
        hex::encode(out.context.rewind_nonce),
    );
    Ok(json)
}

/// Sender finalize: take an S2 slate JSON + the SenderContext fields the
/// sender retained from `sender_init_s1`, produce an S3 slate JSON plus
/// the final aggregated 64-byte Schnorr signature for the kernel.
///
/// The final signature is verified before this function returns; an error
/// is raised if it doesn't check out (which would indicate a bug in slate
/// construction or tampered receiver data).
///
/// Returns JSON: `{ "slate_json": "...", "final_signature_hex": "..." }`.
#[wasm_bindgen]
pub fn grin_sender_finalize_s3(
    s2_slate_json: &str,
    context_slate_id: &str,
    context_amount: u64,
    context_fee: u64,
    context_kernel_kind: &str,
    context_lock_height: Option<u64>,
    context_relative_height: Option<u32>,
    context_sender_blind_excess_hex: &str,
    context_kernel_offset_hex: &str,
    context_kernel_nonce_hex: &str,
) -> Result<String, JsValue> {
    let s2 = grin_ext::slate::parse_slate_v4(s2_slate_json).map_err(|e| JsValue::from_str(&e))?;

    // Reconstruct the SenderContext from caller-supplied fields.
    let kernel_features = build_kernel_features(
        context_kernel_kind,
        Some(context_fee),
        context_lock_height,
        context_relative_height,
    )?;
    let mut excess = [0u8; 32];
    hex::decode_to_slice(context_sender_blind_excess_hex, &mut excess)
        .map_err(|e| JsValue::from_str(&format!("invalid sender_blind_excess_hex: {e}")))?;
    let mut offset = [0u8; 32];
    hex::decode_to_slice(context_kernel_offset_hex, &mut offset)
        .map_err(|e| JsValue::from_str(&format!("invalid kernel_offset_hex: {e}")))?;
    let mut nonce = [0u8; 32];
    hex::decode_to_slice(context_kernel_nonce_hex, &mut nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid kernel_nonce_hex: {e}")))?;

    let context = grin_ext::SenderContext {
        slate_id: context_slate_id.to_string(),
        amount: context_amount,
        fee: context_fee,
        kernel_features,
        sender_blind_excess: excess,
        kernel_nonce: nonce,
        kernel_offset: offset,
    };

    let out = grin_ext::sender_finalize_s3(&grin_ext::SenderFinalizeParams {
        s2_slate: s2,
        sender_context: context,
    })
    .map_err(|e| JsValue::from_str(&e))?;

    let slate_json =
        grin_ext::slate::serialize_slate_v4(&out.slate).map_err(|e| JsValue::from_str(&e))?;
    let slate_json_escaped = slate_json.replace('\\', r"\\").replace('"', r#"\""#);

    let json = format!(
        r#"{{"slate_json":"{}","final_signature_hex":"{}"}}"#,
        slate_json_escaped,
        hex::encode(out.final_signature),
    );
    Ok(json)
}

// =============================================================================
// Invoice flow — receiver-driven (I1 → I2 → I3)
// =============================================================================

/// Receiver-init for an invoice flow: receiver creates the slate first.
#[wasm_bindgen]
pub fn grin_receiver_init_i1(
    slate_id: &str,
    amount: u64,
    fee: u64,
    kernel_kind: &str,
    lock_height: Option<u64>,
    relative_height: Option<u32>,
    receiver_output_blind_hex: &str,
    receiver_kernel_nonce_hex: &str,
    bp_rewind_nonce_hex: &str,
    bp_private_nonce_hex: &str,
    kernel_offset_hex: &str,
) -> Result<String, JsValue> {
    let kernel_features =
        build_kernel_features(kernel_kind, Some(fee), lock_height, relative_height)?;

    let mut output_blind = [0u8; 32];
    hex::decode_to_slice(receiver_output_blind_hex, &mut output_blind)
        .map_err(|e| JsValue::from_str(&format!("invalid receiver_output_blind_hex: {e}")))?;
    let mut kernel_nonce = [0u8; 32];
    hex::decode_to_slice(receiver_kernel_nonce_hex, &mut kernel_nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid receiver_kernel_nonce_hex: {e}")))?;
    let mut rewind = [0u8; 32];
    hex::decode_to_slice(bp_rewind_nonce_hex, &mut rewind)
        .map_err(|e| JsValue::from_str(&format!("invalid bp_rewind_nonce_hex: {e}")))?;
    let mut priv_nonce = [0u8; 32];
    hex::decode_to_slice(bp_private_nonce_hex, &mut priv_nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid bp_private_nonce_hex: {e}")))?;
    let mut offset = [0u8; 32];
    hex::decode_to_slice(kernel_offset_hex, &mut offset)
        .map_err(|e| JsValue::from_str(&format!("invalid kernel_offset_hex: {e}")))?;

    let out = grin_ext::receiver_init_i1_with_id(
        &grin_ext::ReceiverInitI1Params {
            amount,
            fee,
            kernel_features,
            receiver_output_blind: output_blind,
            receiver_kernel_nonce: kernel_nonce,
            bp_rewind_nonce: rewind,
            bp_private_nonce: priv_nonce,
            kernel_offset: offset,
        },
        slate_id.to_string(),
    )
    .map_err(|e| JsValue::from_str(&e))?;

    let slate_json =
        grin_ext::slate::serialize_slate_v4(&out.slate).map_err(|e| JsValue::from_str(&e))?;
    let slate_json_escaped = slate_json.replace('\\', r"\\").replace('"', r#"\""#);

    Ok(format!(
        r#"{{"slate_json":"{}","context":{{"slate_id":"{}","amount":"{}","output_blind_hex":"{}","kernel_nonce_hex":"{}","commitment_hex":"{}","rewind_nonce_hex":"{}"}}}}"#,
        slate_json_escaped,
        out.context.slate_id,
        out.context.amount,
        hex::encode(out.context.output_blind),
        hex::encode(out.context.kernel_nonce),
        hex::encode(out.context.commitment),
        hex::encode(out.context.rewind_nonce),
    ))
}

/// Sender's response to an invoice (I2): adds inputs/change context + their
/// partial signature.
#[wasm_bindgen]
pub fn grin_sender_round_i2(
    i1_slate_json: &str,
    sender_blind_excess_hex: &str,
    sender_kernel_nonce_hex: &str,
) -> Result<String, JsValue> {
    let i1 = grin_ext::slate::parse_slate_v4(i1_slate_json).map_err(|e| JsValue::from_str(&e))?;
    let mut excess = [0u8; 32];
    hex::decode_to_slice(sender_blind_excess_hex, &mut excess)
        .map_err(|e| JsValue::from_str(&format!("invalid sender_blind_excess_hex: {e}")))?;
    let mut nonce = [0u8; 32];
    hex::decode_to_slice(sender_kernel_nonce_hex, &mut nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid sender_kernel_nonce_hex: {e}")))?;

    let out = grin_ext::sender_round_i2(&grin_ext::SenderRoundI2Params {
        i1_slate: i1,
        sender_blind_excess: excess,
        sender_kernel_nonce: nonce,
    })
    .map_err(|e| JsValue::from_str(&e))?;

    let slate_json =
        grin_ext::slate::serialize_slate_v4(&out.slate).map_err(|e| JsValue::from_str(&e))?;
    let slate_json_escaped = slate_json.replace('\\', r"\\").replace('"', r#"\""#);

    Ok(format!(
        r#"{{"slate_json":"{}","context":{{"slate_id":"{}","amount":"{}","fee":"{}","sender_blind_excess_hex":"{}","kernel_offset_hex":"{}","kernel_nonce_hex":"{}"}}}}"#,
        slate_json_escaped,
        out.context.slate_id,
        out.context.amount,
        out.context.fee,
        hex::encode(out.context.sender_blind_excess),
        hex::encode(out.context.kernel_offset),
        hex::encode(out.context.kernel_nonce),
    ))
}

/// Receiver finalize for invoice flow (I3): aggregate partials + verify
/// the final kernel signature.
#[wasm_bindgen]
pub fn grin_receiver_finalize_i3(
    i2_slate_json: &str,
    context_slate_id: &str,
    context_amount: u64,
    context_output_blind_hex: &str,
    context_kernel_nonce_hex: &str,
    context_commitment_hex: &str,
    context_rewind_nonce_hex: &str,
) -> Result<String, JsValue> {
    let i2 = grin_ext::slate::parse_slate_v4(i2_slate_json).map_err(|e| JsValue::from_str(&e))?;
    let mut output_blind = [0u8; 32];
    hex::decode_to_slice(context_output_blind_hex, &mut output_blind)
        .map_err(|e| JsValue::from_str(&format!("invalid output_blind_hex: {e}")))?;
    let mut kernel_nonce = [0u8; 32];
    hex::decode_to_slice(context_kernel_nonce_hex, &mut kernel_nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid kernel_nonce_hex: {e}")))?;
    let mut commit = [0u8; 33];
    hex::decode_to_slice(context_commitment_hex, &mut commit)
        .map_err(|e| JsValue::from_str(&format!("invalid commitment_hex: {e}")))?;
    let mut rewind = [0u8; 32];
    hex::decode_to_slice(context_rewind_nonce_hex, &mut rewind)
        .map_err(|e| JsValue::from_str(&format!("invalid rewind_nonce_hex: {e}")))?;

    let context = grin_ext::ReceiverContext {
        slate_id: context_slate_id.to_string(),
        amount: context_amount,
        output_blind,
        kernel_nonce,
        commitment: commit,
        rewind_nonce: rewind,
    };

    let out = grin_ext::receiver_finalize_i3(&grin_ext::ReceiverFinalizeI3Params {
        i2_slate: i2,
        receiver_context: context,
    })
    .map_err(|e| JsValue::from_str(&e))?;

    let slate_json =
        grin_ext::slate::serialize_slate_v4(&out.slate).map_err(|e| JsValue::from_str(&e))?;
    let slate_json_escaped = slate_json.replace('\\', r"\\").replace('"', r#"\""#);

    Ok(format!(
        r#"{{"slate_json":"{}","final_signature_hex":"{}"}}"#,
        slate_json_escaped,
        hex::encode(out.final_signature),
    ))
}
