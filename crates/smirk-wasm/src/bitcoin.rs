//! WASM exports for BTC and LTC.
//!
//! Each export is a thin wrapper over a `btc-ext` function. Networks are
//! passed as strings (`"btc-mainnet"`, `"btc-testnet"`, `"ltc-mainnet"`,
//! `"ltc-testnet"`) and address kinds as strings (`"p2wpkh"`, `"p2tr"`)
//! to keep the JS surface ergonomic.

use wasm_bindgen::prelude::*;

use btc_ext::{
    address::AddressKind,
    bip32::derive_xpriv,
    bip32::mnemonic_to_xpriv,
    build::{build_psbt, extract_tx, BuildParams, UnsignedInput},
    derive_address,
    network::Network,
    sign_psbt,
};
use serde::Deserialize;

fn parse_network(s: &str) -> Result<Network, JsValue> {
    match s {
        "btc-mainnet" | "btc" => Ok(Network::BtcMainnet),
        "btc-testnet" => Ok(Network::BtcTestnet),
        "ltc-mainnet" | "ltc" => Ok(Network::LtcMainnet),
        "ltc-testnet" => Ok(Network::LtcTestnet),
        other => Err(JsValue::from_str(&format!(
            "unknown network: {other} (expected btc-mainnet | btc-testnet | ltc-mainnet | ltc-testnet)"
        ))),
    }
}

fn parse_address_kind(s: &str) -> Result<AddressKind, JsValue> {
    match s {
        "p2wpkh" | "bip84" => Ok(AddressKind::P2wpkh),
        "p2tr" | "bip86" | "taproot" => Ok(AddressKind::P2tr),
        other => Err(JsValue::from_str(&format!(
            "unknown address kind: {other} (expected p2wpkh | p2tr)"
        ))),
    }
}

/// Derive a BTC or LTC address from a BIP39 mnemonic + BIP32 path.
///
/// Returns the bech32(m)-encoded address string.
///
/// Args:
/// - `mnemonic`: BIP39 mnemonic phrase
/// - `passphrase`: BIP39 passphrase (empty string if unused)
/// - `network`: `"btc-mainnet"` | `"btc-testnet"` | `"ltc-mainnet"` | `"ltc-testnet"`
/// - `path`: BIP32 derivation path (e.g. `"m/84'/0'/0'/0/0"`)
/// - `kind`: `"p2wpkh"` (BIP84) | `"p2tr"` (BIP86)
#[wasm_bindgen]
pub fn btc_derive_address(
    mnemonic: &str,
    passphrase: &str,
    network: &str,
    path: &str,
    kind: &str,
) -> Result<String, JsValue> {
    let net = parse_network(network)?;
    let kind = parse_address_kind(kind)?;
    let master = mnemonic_to_xpriv(mnemonic, passphrase, net)
        .map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let child = derive_xpriv(&master, path).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    derive_address(&child, kind, net).map_err(|e| JsValue::from_str(&format!("{e}")))
}

/// Sign a base64-encoded PSBT with the **master** xprv derived from the
/// mnemonic. `Psbt::sign` walks each input's `bip32_derivation` and checks
/// the fingerprint against the provided xprv — since `btc_build_psbt`
/// stores the master fingerprint, the master xprv is what we must pass
/// here. Earlier revisions passed an account-level xprv and the
/// fingerprint mismatch silently produced empty `partial_sigs`,
/// triggering "PSBT finalization failed: Missing pubkey for a pkh/wpkh"
/// from miniscript downstream.
///
/// Inputs whose origin doesn't match this seed's master fingerprint are
/// left untouched — correct for multi-signer flows.
///
/// The `master_path` parameter is **unused** (kept in the JS signature
/// for backward compatibility with existing v0.3 callers). It can be
/// dropped from the JS facade later; for now the wrapper ignores it.
///
/// Returns JSON: `{ "psbt": "<base64>", "inputs_total": N, "inputs_signed": M }`.
#[wasm_bindgen]
pub fn btc_sign_psbt(
    mnemonic: &str,
    passphrase: &str,
    network: &str,
    _master_path: &str,
    psbt_base64: &str,
) -> Result<String, JsValue> {
    let net = parse_network(network)?;
    let master = mnemonic_to_xpriv(mnemonic, passphrase, net)
        .map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let (psbt_out, report) =
        sign_psbt(psbt_base64, &master).map_err(|e| JsValue::from_str(&format!("{e}")))?;

    Ok(format!(
        r#"{{"psbt":"{}","inputs_total":{},"inputs_signed":{}}}"#,
        psbt_out, report.inputs_total, report.inputs_signed,
    ))
}

/// JSON-deserializable mirror of `btc_ext::build::UnsignedInput`.
///
/// JS-side shape: `{ txid: string, vout: number, value_sat: number,
/// master_path: string }`. Numbers fit in u32/u64 — values larger than
/// `Number.MAX_SAFE_INTEGER` (9.007 PBTC, irrelevant in practice)
/// would need string-typing.
#[derive(Deserialize)]
struct UnsignedInputJson {
    txid: String,
    vout: u32,
    value_sat: u64,
    master_path: String,
}

impl From<UnsignedInputJson> for UnsignedInput {
    fn from(v: UnsignedInputJson) -> Self {
        Self {
            txid: v.txid,
            vout: v.vout,
            value_sat: v.value_sat,
            master_path: v.master_path,
        }
    }
}

#[derive(Deserialize)]
struct BuildPsbtParamsJson {
    network: String,
    inputs: Vec<UnsignedInputJson>,
    recipient_address: String,
    recipient_sat: u64,
    #[serde(default)]
    change_address: Option<String>,
    #[serde(default)]
    change_sat: u64,
    /// BIP39 mnemonic — used to derive the master xprv at build time so
    /// the resulting PSBT carries `bip32_derivation` origin entries that
    /// `btc_sign_psbt` can later resolve.
    mnemonic: String,
    #[serde(default)]
    passphrase: String,
}

/// Build an unsigned base64-encoded PSBT for a BTC/LTC send.
///
/// Input is a single JSON object — see `BuildPsbtParamsJson` for the
/// shape. Output is base64 PSBT string ready to feed into `btc_sign_psbt`.
///
/// v1 scope: single-recipient P2WPKH (BIP84) sends with optional change
/// output. See `btc-ext/src/build.rs` for scope details. Errors come
/// back as `JsValue` strings.
#[wasm_bindgen]
pub fn btc_build_psbt(params_json: &str) -> Result<String, JsValue> {
    let params: BuildPsbtParamsJson = serde_json::from_str(params_json)
        .map_err(|e| JsValue::from_str(&format!("invalid params JSON: {e}")))?;
    let net = parse_network(&params.network)?;
    let master = mnemonic_to_xpriv(&params.mnemonic, &params.passphrase, net)
        .map_err(|e| JsValue::from_str(&format!("{e}")))?;

    let inputs: Vec<UnsignedInput> = params.inputs.into_iter().map(Into::into).collect();
    build_psbt(&BuildParams {
        network: net,
        inputs: &inputs,
        recipient_address: &params.recipient_address,
        recipient_sat: params.recipient_sat,
        change_address: params.change_address.as_deref(),
        change_sat: params.change_sat,
        master_xpriv: &master,
    })
    .map_err(|e| JsValue::from_str(&format!("{e}")))
}

/// Extract the final network-broadcastable transaction hex from a fully-
/// signed PSBT. After `btc_sign_psbt` has populated every input's witness,
/// this finalizes the PSBT and serializes the resulting transaction as
/// raw hex ready for the `/wallet/broadcast` endpoint.
#[wasm_bindgen]
pub fn btc_extract_tx(psbt_base64: &str) -> Result<String, JsValue> {
    extract_tx(psbt_base64).map_err(|e| JsValue::from_str(&format!("{e}")))
}
