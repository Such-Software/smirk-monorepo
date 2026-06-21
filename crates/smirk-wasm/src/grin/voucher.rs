//! Wasm exports for Grin voucher transactions — the non-interactive
//! UTXO transfer pattern used by social tipping.
//!
//! Two orchestrators:
//!   - `grin_create_grin_voucher` (sender side): builds a single-party
//!     tx that places a voucher UTXO on chain, returns the secret
//!     blinding factor for the JS layer to encrypt to the recipient.
//!   - `grin_sweep_grin_voucher` (claimer side): given the decrypted
//!     blinding factor, sweeps the voucher UTXO into a new output the
//!     claimer controls.
//!
//! Wire shape: JSON params in, JSON result out. Hex-encoded byte
//! fields. snake_case field names.

use wasm_bindgen::prelude::*;

use grin_ext::{
    create_grin_voucher, sweep_grin_voucher, ChangePath, CreateVoucherParams,
    SweepVoucherParams, UnspentOutput,
};

fn hex_to_32(s: &str, name: &str) -> Result<[u8; 32], JsValue> {
    let mut out = [0u8; 32];
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

fn hex_to_64(s: &str, name: &str) -> Result<[u8; 64], JsValue> {
    let mut out = [0u8; 64];
    hex::decode_to_slice(s, &mut out)
        .map_err(|e| JsValue::from_str(&format!("invalid hex for {name}: {e}")))?;
    Ok(out)
}

fn err_string(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

mod dto {
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, Deserialize)]
    pub struct UnspentOutputDto {
        pub path: [u32; 4],
        pub amount: u64,
        pub commitment_hex: String,
        #[serde(default)]
        pub is_coinbase: bool,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct ChangePathDto {
        pub path: [u32; 4],
        pub amount: u64,
    }

    #[derive(Debug, Deserialize)]
    pub struct CreateVoucherParamsDto {
        pub extended_private_key_hex: String,
        pub inputs: Vec<UnspentOutputDto>,
        pub voucher_amount: u64,
        pub fee: u64,
        pub voucher_path: [u32; 4],
        pub change: Option<ChangePathDto>,
        pub kernel_offset_hex: String,
        pub kernel_nonce_hex: String,
        pub bp_rewind_nonce_hex: String,
        pub bp_private_nonce_hex: String,
        #[serde(default)]
        pub change_bp_rewind_nonce_hex: Option<String>,
        #[serde(default)]
        pub change_bp_private_nonce_hex: Option<String>,
        /// LEGACY ext key for input-blind fallback (tip a recovered Grim/
        /// legacy depth-3 output). Absent on older callers → None.
        #[serde(default)]
        pub legacy_extended_private_key_hex: Option<String>,
    }

    #[derive(Debug, Serialize)]
    pub struct VoucherOutputDto {
        pub path: [u32; 4],
        pub amount: u64,
        pub commitment_hex: String,
        pub proof_hex: String,
        /// SECRET — caller (JS) encrypts this to recipient via ECIES
        /// or URL fragment key. Never log; never transmit plaintext.
        pub blinding_factor_hex: String,
    }

    #[derive(Debug, Serialize)]
    pub struct ChangeOutputInfoDto {
        pub path: [u32; 4],
        pub amount: u64,
        pub commitment_hex: String,
        pub proof_hex: String,
    }

    /// Mirror of `grin_ext::voucher::CreateVoucherResult` on the wire.
    /// `tx_json` carries the same data as `tx_bytes_hex` but in the
    /// JSON shape Grin's `/v2/foreign push_transaction` accepts —
    /// hand to backend broadcast unchanged. Sending
    /// `{tx_bytes_hex}` instead fails with
    /// `InvalidArgStructure "tx"` at the node.
    #[derive(Debug, Serialize)]
    pub struct CreateVoucherResultDto {
        pub voucher: VoucherOutputDto,
        pub change: Option<ChangeOutputInfoDto>,
        pub kernel_excess_hex: String,
        pub tx_bytes_hex: String,
        pub tx_json: serde_json::Value,
    }

    #[derive(Debug, Deserialize)]
    pub struct SweepVoucherParamsDto {
        pub extended_private_key_hex: String,
        pub voucher_commitment_hex: String,
        pub voucher_blind_hex: String,
        pub voucher_amount: u64,
        #[serde(default)]
        pub voucher_features: u8,
        pub claimer_path: [u32; 4],
        pub fee: u64,
        pub kernel_offset_hex: String,
        pub kernel_nonce_hex: String,
        pub bp_rewind_nonce_hex: String,
        pub bp_private_nonce_hex: String,
    }

    #[derive(Debug, Serialize)]
    pub struct SweepVoucherResultDto {
        pub output: ChangeOutputInfoDto,
        pub kernel_excess_hex: String,
        pub tx_bytes_hex: String,
        /// JSON-shaped Transaction body. Hand straight to the
        /// backend's broadcast endpoint as the `tx` field — same
        /// contract as `FinalizeSendResultDto.tx_json` for the
        /// slate-ceremony flow. Without this the caller would have
        /// to re-deserialize tx_bytes_hex from the custom wire
        /// format, which the JS side has no decoder for.
        pub tx_json: serde_json::Value,
    }
}

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

#[wasm_bindgen]
pub fn grin_create_grin_voucher(params_json: &str) -> Result<String, JsValue> {
    let d: dto::CreateVoucherParamsDto =
        serde_json::from_str(params_json).map_err(err_string)?;
    let inputs = unspent_outputs_from_dtos(&d.inputs)?;
    let change = d.change.map(|c| ChangePath {
        path: c.path,
        amount: c.amount,
    });
    let zero32 = [0u8; 32];
    let params = CreateVoucherParams {
        extended_private_key: hex_to_64(&d.extended_private_key_hex, "extended_private_key_hex")?,
        legacy_extended_private_key: match d.legacy_extended_private_key_hex {
            Some(s) => Some(hex_to_64(&s, "legacy_extended_private_key_hex")?),
            None => None,
        },
        inputs,
        voucher_amount: d.voucher_amount,
        fee: d.fee,
        voucher_path: d.voucher_path,
        change,
        kernel_offset: hex_to_32(&d.kernel_offset_hex, "kernel_offset_hex")?,
        kernel_nonce: hex_to_32(&d.kernel_nonce_hex, "kernel_nonce_hex")?,
        bp_rewind_nonce: hex_to_32(&d.bp_rewind_nonce_hex, "bp_rewind_nonce_hex")?,
        bp_private_nonce: hex_to_32(&d.bp_private_nonce_hex, "bp_private_nonce_hex")?,
        change_bp_rewind_nonce: match d.change_bp_rewind_nonce_hex {
            Some(s) => hex_to_32(&s, "change_bp_rewind_nonce_hex")?,
            None => zero32,
        },
        change_bp_private_nonce: match d.change_bp_private_nonce_hex {
            Some(s) => hex_to_32(&s, "change_bp_private_nonce_hex")?,
            None => zero32,
        },
    };
    let out = create_grin_voucher(&params).map_err(err_string)?;

    let result = dto::CreateVoucherResultDto {
        voucher: dto::VoucherOutputDto {
            path: out.voucher.path,
            amount: out.voucher.amount,
            commitment_hex: hex::encode(out.voucher.commitment),
            proof_hex: hex::encode(&out.voucher.proof),
            blinding_factor_hex: hex::encode(out.voucher.blinding_factor),
        },
        change: out.change.map(|c| dto::ChangeOutputInfoDto {
            path: c.path,
            amount: c.amount,
            commitment_hex: hex::encode(c.commitment),
            proof_hex: hex::encode(c.proof),
        }),
        kernel_excess_hex: hex::encode(out.kernel_excess),
        tx_bytes_hex: hex::encode(out.tx_bytes),
        tx_json: out.tx_json,
    };
    serde_json::to_string(&result).map_err(err_string)
}

#[wasm_bindgen]
pub fn grin_sweep_grin_voucher(params_json: &str) -> Result<String, JsValue> {
    let d: dto::SweepVoucherParamsDto = serde_json::from_str(params_json).map_err(err_string)?;
    let params = SweepVoucherParams {
        extended_private_key: hex_to_64(&d.extended_private_key_hex, "extended_private_key_hex")?,
        voucher_commitment: hex_to_33(&d.voucher_commitment_hex, "voucher_commitment_hex")?,
        voucher_blind: hex_to_32(&d.voucher_blind_hex, "voucher_blind_hex")?,
        voucher_amount: d.voucher_amount,
        voucher_features: d.voucher_features,
        claimer_path: d.claimer_path,
        fee: d.fee,
        kernel_offset: hex_to_32(&d.kernel_offset_hex, "kernel_offset_hex")?,
        kernel_nonce: hex_to_32(&d.kernel_nonce_hex, "kernel_nonce_hex")?,
        bp_rewind_nonce: hex_to_32(&d.bp_rewind_nonce_hex, "bp_rewind_nonce_hex")?,
        bp_private_nonce: hex_to_32(&d.bp_private_nonce_hex, "bp_private_nonce_hex")?,
    };
    let out = sweep_grin_voucher(&params).map_err(err_string)?;

    let result = dto::SweepVoucherResultDto {
        output: dto::ChangeOutputInfoDto {
            path: out.output.path,
            amount: out.output.amount,
            commitment_hex: hex::encode(out.output.commitment),
            proof_hex: hex::encode(out.output.proof),
        },
        kernel_excess_hex: hex::encode(out.kernel_excess),
        tx_bytes_hex: hex::encode(out.tx_bytes),
        tx_json: out.tx_json,
    };
    serde_json::to_string(&result).map_err(err_string)
}
