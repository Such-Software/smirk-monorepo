//! WASM exports for BTC and LTC.
//!
//! Each export is a thin wrapper over a `btc-ext` function. Networks are
//! passed as strings (`"btc-mainnet"`, `"btc-testnet"`, `"ltc-mainnet"`,
//! `"ltc-testnet"`) and address kinds as strings (`"p2wpkh"`, `"p2tr"`)
//! to keep the JS surface ergonomic.

use wasm_bindgen::prelude::*;

use btc_ext::{
    address::AddressKind, bip32::derive_xpriv, bip32::mnemonic_to_xpriv, derive_address,
    network::Network, sign_psbt,
};

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

/// Sign a base64-encoded PSBT using a key derived from `mnemonic` at
/// `master_path` (typically the account-level path, e.g. `"m/84'/0'/0'"`).
///
/// rust-bitcoin's PSBT signer walks the per-input `bip32_derivation` map
/// and signs every input whose origin info matches the derived xprv's
/// fingerprint + path. Inputs that don't match are left untouched.
///
/// Returns JSON: `{ "psbt": "<base64>", "inputs_total": N, "inputs_signed": M }`.
#[wasm_bindgen]
pub fn btc_sign_psbt(
    mnemonic: &str,
    passphrase: &str,
    network: &str,
    master_path: &str,
    psbt_base64: &str,
) -> Result<String, JsValue> {
    let net = parse_network(network)?;
    let master = mnemonic_to_xpriv(mnemonic, passphrase, net)
        .map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let xprv =
        derive_xpriv(&master, master_path).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let (psbt_out, report) =
        sign_psbt(psbt_base64, &xprv).map_err(|e| JsValue::from_str(&format!("{e}")))?;

    Ok(format!(
        r#"{{"psbt":"{}","inputs_total":{},"inputs_signed":{}}}"#,
        psbt_out, report.inputs_total, report.inputs_signed,
    ))
}
