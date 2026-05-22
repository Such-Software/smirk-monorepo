//! Wasm exports for the 6 high-level Grin wallet orchestrators.
//!
//! Each function takes a single JSON params string (the JS side already
//! has JSON state) and returns a single JSON result string. Inputs use
//! snake_case field names matching the Rust struct definitions in
//! `grin_ext::wallet_flows`; outputs include hex-encoded bytes,
//! serialized SlateV4 JSON, and any IDs / amounts the wallet needs to
//! persist.
//!
//! For each orchestrator there's a corresponding JSON DTO in the
//! `dto` submodule below. The DTOs are private to this crate; the JS
//! contract is the JSON shape they produce.

use wasm_bindgen::prelude::*;

use grin_ext::{
    create_invoice, create_send_transaction, finalize_invoice, finalize_send_slate,
    serialize_slate_v4, serialize_slate_v4_bin, sign_incoming_send_slate, sign_invoice,
    ChangeOutputInfo, CreateInvoiceParams, CreateSendTxParams, FinalizeInvoiceParams,
    FinalizeSendParams, KernelFeatures, ReceiverContext, SenderContext, SignIncomingSendParams,
    SignInvoiceParams, UnspentOutput,
};

// ============================================================================
// Helpers
// ============================================================================

fn hex_to_32(s: &str, name: &str) -> Result<[u8; 32], JsValue> {
    let mut out = [0u8; 32];
    hex::decode_to_slice(s, &mut out)
        .map_err(|e| JsValue::from_str(&format!("invalid hex for {name}: {e}")))?;
    Ok(out)
}

fn hex_to_64(s: &str, name: &str) -> Result<[u8; 64], JsValue> {
    let mut out = [0u8; 64];
    hex::decode_to_slice(s, &mut out)
        .map_err(|e| JsValue::from_str(&format!("invalid hex for {name}: {e}")))?;
    Ok(out)
}

fn hex_to_33(s: &str, name: &str) -> Result<[u8; 33], JsValue> {
    let mut out = [0u8; 33];
    hex::decode_to_slice(s, &mut out)
        .map_err(|e| JsValue::from_str(&format!("invalid hex for {name}: {e}")))?;
    Ok(out)
}

fn err_string(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn kernel_features_from_str(
    kind: &str,
    fee: u64,
    lock_height: Option<u64>,
    relative_height: Option<u32>,
) -> Result<KernelFeatures, JsValue> {
    use grin_ext::kernel::KernelFeatures as K;
    Ok(match kind {
        "plain" => K::Plain { fee },
        "coinbase" => K::Coinbase,
        "height_locked" => K::HeightLocked {
            fee,
            lock_height: lock_height
                .ok_or_else(|| JsValue::from_str("height_locked kernel requires lock_height"))?,
        },
        "nrd" => {
            let rh = relative_height
                .ok_or_else(|| JsValue::from_str("nrd kernel requires relative_height"))?;
            let rh = u16::try_from(rh).map_err(|_| {
                JsValue::from_str(&format!("nrd relative_height {rh} exceeds u16 range"))
            })?;
            K::Nrd { fee, relative_height: rh }
        }
        other => return Err(JsValue::from_str(&format!("unknown kernel kind: {other}"))),
    })
}

// ============================================================================
// DTOs — JSON shapes the JS side sends in / receives out
// ============================================================================

mod dto {
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, Deserialize)]
    pub struct UnspentOutputDto {
        pub path: [u32; 4],
        pub amount: u64,
        /// 33-byte commitment, hex.
        pub commitment_hex: String,
        #[serde(default)]
        pub is_coinbase: bool,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct ChangeOutputInfoDto {
        pub path: [u32; 4],
        pub amount: u64,
        pub commitment_hex: String,
        /// Bulletproof bytes, hex.
        pub proof_hex: String,
    }

    #[derive(Debug, Clone, Serialize)]
    pub struct ReceiverOutputInfoDto {
        pub path: [u32; 4],
        pub amount: u64,
        pub commitment_hex: String,
        pub proof_hex: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct CreateSendTxParamsDto {
        pub extended_private_key_hex: String,
        /// LEGACY ext key for v0.2.x pre-2026-05-rotation outputs.
        /// Optional. When the v3 derive_blind doesn't reproduce an
        /// input's commitment, the orchestrator falls back to this key.
        #[serde(default)]
        pub legacy_extended_private_key_hex: Option<String>,
        pub inputs: Vec<UnspentOutputDto>,
        pub amount: u64,
        pub fee: u64,
        pub kernel_kind: String,
        #[serde(default)]
        pub lock_height: Option<u64>,
        #[serde(default)]
        pub relative_height: Option<u32>,
        pub change_path: [u32; 4],
        pub kernel_offset_hex: String,
        pub kernel_nonce_hex: String,
        pub bp_rewind_nonce_hex: String,
        pub bp_private_nonce_hex: String,
        #[serde(default)]
        pub slate_id: Option<String>,
    }

    #[derive(Debug, Clone, Serialize)]
    pub struct CreateSendTxResultDto {
        /// Slate v4 JSON.
        pub slate_json: String,
        /// Compact-binary slate (slatepack payload), hex.
        pub slate_bin_hex: String,
        pub slate_id: String,
        /// Sender context — opaque JSON the caller persists for finalize.
        pub sender_context_json: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub change_output: Option<ChangeOutputInfoDto>,
        /// Per-input label of which derivation candidate matched
        /// ("v3+Regular", "legacy+Regular", "v3+None", "legacy+None").
        /// Same length and order as the input list. Diagnostic.
        pub input_derivations: Vec<String>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct SignIncomingSendParamsDto {
        pub extended_private_key_hex: String,
        pub s1_slate_json: String,
        pub output_path: [u32; 4],
        pub receiver_kernel_nonce_hex: String,
        pub bp_rewind_nonce_hex: String,
        pub bp_private_nonce_hex: String,
    }

    #[derive(Debug, Clone, Serialize)]
    pub struct SignIncomingSendResultDto {
        pub slate_json: String,
        pub slate_bin_hex: String,
        pub output: ReceiverOutputInfoDto,
        pub kernel_excess_hex: String,
        pub receiver_context_json: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct FinalizeSendParamsDto {
        pub s2_slate_json: String,
        pub sender_context_json: String,
        pub sender_inputs: Vec<UnspentOutputDto>,
        #[serde(default)]
        pub change_output: Option<ChangeOutputInfoDto>,
    }

    #[derive(Debug, Clone, Serialize)]
    pub struct FinalizeSendResultDto {
        pub slate_json: String,
        pub final_signature_hex: String,
        pub kernel_excess_hex: String,
        /// Binary wire format transaction bytes, hex. Used for the
        /// P2P / gossip path or local round-trip testing.
        pub tx_bytes_hex: String,
        /// JSON-shaped Transaction object — pass this to the backend
        /// broadcast endpoint's `tx` field unchanged. Grin's
        /// `/v2/foreign push_transaction` deserializes this as a
        /// `grin_core::Transaction`. Sending the hex bytes instead
        /// (the old shape) fails with
        /// `InvalidArgStructure "tx" at position 0`.
        pub tx_json: serde_json::Value,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct CreateInvoiceParamsDto {
        pub extended_private_key_hex: String,
        pub amount: u64,
        pub fee: u64,
        pub kernel_kind: String,
        #[serde(default)]
        pub lock_height: Option<u64>,
        #[serde(default)]
        pub relative_height: Option<u32>,
        pub output_path: [u32; 4],
        pub kernel_offset_hex: String,
        pub receiver_kernel_nonce_hex: String,
        pub bp_rewind_nonce_hex: String,
        pub bp_private_nonce_hex: String,
        #[serde(default)]
        pub slate_id: Option<String>,
    }

    #[derive(Debug, Clone, Serialize)]
    pub struct CreateInvoiceResultDto {
        pub slate_json: String,
        pub slate_bin_hex: String,
        pub slate_id: String,
        pub receiver_context_json: String,
        pub output: ReceiverOutputInfoDto,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct SignInvoiceParamsDto {
        pub extended_private_key_hex: String,
        /// LEGACY ext key — same purpose as in CreateSendTxParamsDto.
        #[serde(default)]
        pub legacy_extended_private_key_hex: Option<String>,
        pub i1_slate_json: String,
        pub inputs: Vec<UnspentOutputDto>,
        pub change_path: [u32; 4],
        pub sender_kernel_nonce_hex: String,
        pub bp_rewind_nonce_hex: String,
        pub bp_private_nonce_hex: String,
    }

    #[derive(Debug, Clone, Serialize)]
    pub struct SignInvoiceResultDto {
        pub slate_json: String,
        pub slate_bin_hex: String,
        pub sender_context_json: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub change_output: Option<ChangeOutputInfoDto>,
        /// Per-input label of which derivation candidate matched. Diagnostic.
        pub input_derivations: Vec<String>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct FinalizeInvoiceParamsDto {
        pub i2_slate_json: String,
        pub receiver_context_json: String,
        pub sender_inputs: Vec<UnspentOutputDto>,
    }

    #[derive(Debug, Clone, Serialize)]
    pub struct FinalizeInvoiceResultDto {
        pub slate_json: String,
        pub final_signature_hex: String,
        pub kernel_excess_hex: String,
        pub tx_bytes_hex: String,
        /// JSON-shaped Transaction — see FinalizeSendResultDto.tx_json.
        pub tx_json: serde_json::Value,
    }
}

// ============================================================================
// Convert DTOs ↔ grin_ext params
// ============================================================================

fn unspent_outputs_from_dtos(
    dtos: &[dto::UnspentOutputDto],
) -> Result<Vec<UnspentOutput>, JsValue> {
    dtos.iter()
        .map(|d| {
            Ok(UnspentOutput {
                path: d.path,
                amount: d.amount,
                commitment: hex_to_33(&d.commitment_hex, "commitment_hex")?,
                is_coinbase: d.is_coinbase,
            })
        })
        .collect()
}

fn change_output_from_dto(d: &dto::ChangeOutputInfoDto) -> Result<ChangeOutputInfo, JsValue> {
    Ok(ChangeOutputInfo {
        path: d.path,
        amount: d.amount,
        commitment: hex_to_33(&d.commitment_hex, "change_output.commitment_hex")?,
        proof: hex::decode(&d.proof_hex).map_err(err_string)?,
    })
}

fn change_output_to_dto(c: &ChangeOutputInfo) -> dto::ChangeOutputInfoDto {
    dto::ChangeOutputInfoDto {
        path: c.path,
        amount: c.amount,
        commitment_hex: hex::encode(c.commitment),
        proof_hex: hex::encode(&c.proof),
    }
}

// ============================================================================
// Wasm exports — the 6 orchestrators
// ============================================================================

#[wasm_bindgen]
pub fn grin_create_send_transaction(params_json: &str) -> Result<String, JsValue> {
    let d: dto::CreateSendTxParamsDto =
        serde_json::from_str(params_json).map_err(err_string)?;
    let inputs = unspent_outputs_from_dtos(&d.inputs)?;
    let kernel_features =
        kernel_features_from_str(&d.kernel_kind, d.fee, d.lock_height, d.relative_height)?;
    let legacy_ext_key = match d.legacy_extended_private_key_hex.as_ref() {
        Some(hex) => Some(hex_to_64(hex, "legacy_extended_private_key_hex")?),
        None => None,
    };
    let params = CreateSendTxParams {
        extended_private_key: hex_to_64(&d.extended_private_key_hex, "extended_private_key_hex")?,
        legacy_extended_private_key: legacy_ext_key,
        inputs,
        amount: d.amount,
        fee: d.fee,
        kernel_features,
        change_path: d.change_path,
        kernel_offset: hex_to_32(&d.kernel_offset_hex, "kernel_offset_hex")?,
        kernel_nonce: hex_to_32(&d.kernel_nonce_hex, "kernel_nonce_hex")?,
        bp_rewind_nonce: hex_to_32(&d.bp_rewind_nonce_hex, "bp_rewind_nonce_hex")?,
        bp_private_nonce: hex_to_32(&d.bp_private_nonce_hex, "bp_private_nonce_hex")?,
        slate_id: d.slate_id,
    };
    let out = create_send_transaction(&params).map_err(err_string)?;
    let slate_json = serialize_slate_v4(&out.slate).map_err(err_string)?;
    let slate_bin = serialize_slate_v4_bin(&out.slate).map_err(err_string)?;
    let result = dto::CreateSendTxResultDto {
        slate_id: out.slate.id.clone(),
        slate_json,
        slate_bin_hex: hex::encode(slate_bin),
        sender_context_json: serde_json::to_string(&out.context).map_err(err_string)?,
        change_output: out.change_output.as_ref().map(change_output_to_dto),
        input_derivations: out.input_derivations.clone(),
    };
    serde_json::to_string(&result).map_err(err_string)
}

#[wasm_bindgen]
pub fn grin_sign_incoming_send_slate(params_json: &str) -> Result<String, JsValue> {
    let d: dto::SignIncomingSendParamsDto =
        serde_json::from_str(params_json).map_err(err_string)?;
    let s1_slate =
        grin_ext::parse_slate_v4(&d.s1_slate_json).map_err(err_string)?;
    let params = SignIncomingSendParams {
        extended_private_key: hex_to_64(&d.extended_private_key_hex, "extended_private_key_hex")?,
        s1_slate,
        output_path: d.output_path,
        receiver_kernel_nonce: hex_to_32(&d.receiver_kernel_nonce_hex, "receiver_kernel_nonce_hex")?,
        bp_rewind_nonce: hex_to_32(&d.bp_rewind_nonce_hex, "bp_rewind_nonce_hex")?,
        bp_private_nonce: hex_to_32(&d.bp_private_nonce_hex, "bp_private_nonce_hex")?,
    };
    let out = sign_incoming_send_slate(&params).map_err(err_string)?;
    let slate_json = serialize_slate_v4(&out.slate).map_err(err_string)?;
    let slate_bin = serialize_slate_v4_bin(&out.slate).map_err(err_string)?;
    let result = dto::SignIncomingSendResultDto {
        slate_json,
        slate_bin_hex: hex::encode(slate_bin),
        output: dto::ReceiverOutputInfoDto {
            path: out.output.path,
            amount: out.output.amount,
            commitment_hex: hex::encode(out.output.commitment),
            proof_hex: hex::encode(&out.output.proof),
        },
        kernel_excess_hex: hex::encode(out.kernel_excess),
        receiver_context_json: serde_json::to_string(&out.context).map_err(err_string)?,
    };
    serde_json::to_string(&result).map_err(err_string)
}

#[wasm_bindgen]
pub fn grin_finalize_send_slate(params_json: &str) -> Result<String, JsValue> {
    let d: dto::FinalizeSendParamsDto = serde_json::from_str(params_json).map_err(err_string)?;
    let s2_slate = grin_ext::parse_slate_v4(&d.s2_slate_json).map_err(err_string)?;
    let sender_context: SenderContext =
        serde_json::from_str(&d.sender_context_json).map_err(err_string)?;
    let sender_inputs = unspent_outputs_from_dtos(&d.sender_inputs)?;
    let change_output = d
        .change_output
        .as_ref()
        .map(change_output_from_dto)
        .transpose()?;
    let params = FinalizeSendParams {
        s2_slate,
        sender_context,
        sender_inputs,
        change_output,
    };
    let out = finalize_send_slate(&params).map_err(err_string)?;
    let slate_json = serialize_slate_v4(&out.slate).map_err(err_string)?;
    let result = dto::FinalizeSendResultDto {
        slate_json,
        final_signature_hex: hex::encode(out.final_signature),
        kernel_excess_hex: hex::encode(out.kernel_excess),
        tx_bytes_hex: hex::encode(&out.tx_bytes),
        tx_json: out.tx_json,
    };
    serde_json::to_string(&result).map_err(err_string)
}

#[wasm_bindgen]
pub fn grin_create_invoice(params_json: &str) -> Result<String, JsValue> {
    let d: dto::CreateInvoiceParamsDto =
        serde_json::from_str(params_json).map_err(err_string)?;
    let kernel_features =
        kernel_features_from_str(&d.kernel_kind, d.fee, d.lock_height, d.relative_height)?;
    let params = CreateInvoiceParams {
        extended_private_key: hex_to_64(&d.extended_private_key_hex, "extended_private_key_hex")?,
        amount: d.amount,
        fee: d.fee,
        kernel_features,
        output_path: d.output_path,
        kernel_offset: hex_to_32(&d.kernel_offset_hex, "kernel_offset_hex")?,
        receiver_kernel_nonce: hex_to_32(&d.receiver_kernel_nonce_hex, "receiver_kernel_nonce_hex")?,
        bp_rewind_nonce: hex_to_32(&d.bp_rewind_nonce_hex, "bp_rewind_nonce_hex")?,
        bp_private_nonce: hex_to_32(&d.bp_private_nonce_hex, "bp_private_nonce_hex")?,
        slate_id: d.slate_id,
    };
    let out = create_invoice(&params).map_err(err_string)?;
    let slate_json = serialize_slate_v4(&out.slate).map_err(err_string)?;
    let slate_bin = serialize_slate_v4_bin(&out.slate).map_err(err_string)?;
    let result = dto::CreateInvoiceResultDto {
        slate_id: out.slate.id.clone(),
        slate_json,
        slate_bin_hex: hex::encode(slate_bin),
        receiver_context_json: serde_json::to_string(&out.context).map_err(err_string)?,
        output: dto::ReceiverOutputInfoDto {
            path: out.output.path,
            amount: out.output.amount,
            commitment_hex: hex::encode(out.output.commitment),
            proof_hex: hex::encode(&out.output.proof),
        },
    };
    serde_json::to_string(&result).map_err(err_string)
}

#[wasm_bindgen]
pub fn grin_sign_invoice(params_json: &str) -> Result<String, JsValue> {
    let d: dto::SignInvoiceParamsDto = serde_json::from_str(params_json).map_err(err_string)?;
    let i1_slate = grin_ext::parse_slate_v4(&d.i1_slate_json).map_err(err_string)?;
    let inputs = unspent_outputs_from_dtos(&d.inputs)?;
    let legacy_ext_key = match d.legacy_extended_private_key_hex.as_ref() {
        Some(hex) => Some(hex_to_64(hex, "legacy_extended_private_key_hex")?),
        None => None,
    };
    let params = SignInvoiceParams {
        extended_private_key: hex_to_64(&d.extended_private_key_hex, "extended_private_key_hex")?,
        legacy_extended_private_key: legacy_ext_key,
        i1_slate,
        inputs,
        change_path: d.change_path,
        sender_kernel_nonce: hex_to_32(&d.sender_kernel_nonce_hex, "sender_kernel_nonce_hex")?,
        bp_rewind_nonce: hex_to_32(&d.bp_rewind_nonce_hex, "bp_rewind_nonce_hex")?,
        bp_private_nonce: hex_to_32(&d.bp_private_nonce_hex, "bp_private_nonce_hex")?,
    };
    let out = sign_invoice(&params).map_err(err_string)?;
    let slate_json = serialize_slate_v4(&out.slate).map_err(err_string)?;
    let slate_bin = serialize_slate_v4_bin(&out.slate).map_err(err_string)?;
    let result = dto::SignInvoiceResultDto {
        slate_json,
        slate_bin_hex: hex::encode(slate_bin),
        sender_context_json: serde_json::to_string(&out.context).map_err(err_string)?,
        change_output: out.change_output.as_ref().map(change_output_to_dto),
        input_derivations: out.input_derivations.clone(),
    };
    serde_json::to_string(&result).map_err(err_string)
}

#[wasm_bindgen]
pub fn grin_finalize_invoice(params_json: &str) -> Result<String, JsValue> {
    let d: dto::FinalizeInvoiceParamsDto =
        serde_json::from_str(params_json).map_err(err_string)?;
    let i2_slate = grin_ext::parse_slate_v4(&d.i2_slate_json).map_err(err_string)?;
    let receiver_context: ReceiverContext =
        serde_json::from_str(&d.receiver_context_json).map_err(err_string)?;
    let sender_inputs = unspent_outputs_from_dtos(&d.sender_inputs)?;
    let params = FinalizeInvoiceParams {
        i2_slate,
        receiver_context,
        sender_inputs,
    };
    let out = finalize_invoice(&params).map_err(err_string)?;
    let slate_json = serialize_slate_v4(&out.slate).map_err(err_string)?;
    let result = dto::FinalizeInvoiceResultDto {
        slate_json,
        final_signature_hex: hex::encode(out.final_signature),
        kernel_excess_hex: hex::encode(out.kernel_excess),
        tx_bytes_hex: hex::encode(&out.tx_bytes),
        tx_json: out.tx_json,
    };
    serde_json::to_string(&result).map_err(err_string)
}

// ============================================================================
// Misc helpers exposed
// ============================================================================

/// Random fresh 32-byte secp256k1 scalar (for kernel nonces, BP nonces).
/// Returns hex.
#[wasm_bindgen]
pub fn grin_random_secret_nonce() -> String {
    hex::encode(grin_ext::random_secret_nonce())
}

/// Serialize a slate JSON to its compact binary form (slatepack payload).
/// Input: slate v4 JSON string. Output: hex-encoded binary bytes.
#[wasm_bindgen]
pub fn grin_slate_v4_to_bin_hex(slate_json: &str) -> Result<String, JsValue> {
    let slate = grin_ext::parse_slate_v4(slate_json).map_err(err_string)?;
    let bin = serialize_slate_v4_bin(&slate).map_err(err_string)?;
    Ok(hex::encode(bin))
}

/// Inverse of `grin_slate_v4_to_bin_hex`. Input: hex-encoded binary bytes.
/// Output: slate v4 JSON string.
#[wasm_bindgen]
pub fn grin_slate_v4_from_bin_hex(bin_hex: &str) -> Result<String, JsValue> {
    let bin = hex::decode(bin_hex).map_err(err_string)?;
    let slate = grin_ext::deserialize_slate_v4_bin(&bin).map_err(err_string)?;
    serialize_slate_v4(&slate).map_err(err_string)
}
