//! Seed → extended key, public key derivation, slatepack address.

use wasm_bindgen::prelude::*;

/// Derive the 64-byte Grin extended private key from a BIP39 mnemonic.
///
/// Matches `grin-wallet` and Grim — uses HMAC-SHA512 with key `"IamVoldemort"`
/// over the raw BIP39 entropy (NOT the 64-byte BIP39 PBKDF2 seed).
///
/// Returns JSON: `{ "extended_private_key_hex": "...", "secret_key_hex": "...", "chain_code_hex": "..." }`.
#[wasm_bindgen]
pub fn grin_derive_extended_key(mnemonic: &str) -> Result<String, JsValue> {
    let xkey = grin_ext::mnemonic_to_extended_private_key(mnemonic)
        .map_err(|e| JsValue::from_str(&e))?;

    let json = format!(
        r#"{{"extended_private_key_hex":"{}","secret_key_hex":"{}","chain_code_hex":"{}"}}"#,
        xkey.to_hex(),
        hex::encode(xkey.secret_key()),
        hex::encode(xkey.chain_code()),
    );
    Ok(json)
}

/// LEGACY: derive the v1/v2-style ext key (`useBip39=true` —
/// PBKDF2-then-HMAC). Used to compute the fallback ext-key the
/// orchestrators try when the v3 derivation can't reproduce a
/// stored input commitment. Sunset 2026-11-15.
///
/// Returns hex of the 64-byte ext key (no JSON wrapper — single-purpose).
#[wasm_bindgen]
pub fn grin_derive_extended_key_legacy_bip39(mnemonic: &str) -> Result<String, JsValue> {
    let xkey = grin_ext::mnemonic_to_extended_private_key_legacy_bip39(mnemonic)
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(xkey.to_hex())
}

/// Derive the compressed secp256k1 public key (33 bytes) from a 32-byte
/// secret key. Both arguments and return value are hex-encoded strings.
///
/// Equivalent to `Secp256k1Zkp.publicKeyFromSecretKey(secretKey)` in the
/// MWC WASM stack.
#[wasm_bindgen]
pub fn grin_secp256k1_public_key(secret_key_hex: &str) -> Result<String, JsValue> {
    let mut sk = [0u8; 32];
    hex::decode_to_slice(secret_key_hex, &mut sk)
        .map_err(|e| JsValue::from_str(&format!("invalid secret_key_hex: {e}")))?;

    let pk = grin_ext::public_key_from_secret_key(&sk).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(pk))
}

/// Derive the full Grin keyset from a mnemonic in one call. Convenience
/// wrapper that bundles the extended key, root secp256k1 pubkey, and the
/// default (index-0) slatepack address.
///
/// `network` must be `"mainnet"` or `"testnet"`.
///
/// Returns JSON:
/// ```text
/// {
///   "extended_private_key_hex": "...",  // 128 hex chars (64 bytes)
///   "secret_key_hex": "...",            //  64 hex chars (32 bytes)
///   "chain_code_hex": "...",            //  64 hex chars (32 bytes)
///   "public_key_hex": "...",            //  66 hex chars (33 bytes, compressed)
///   "slatepack_address": "grin1..."     // bech32, default address index 0
/// }
/// ```
#[wasm_bindgen]
pub fn grin_derive_keys(mnemonic: &str, network: &str) -> Result<String, JsValue> {
    let xkey = grin_ext::mnemonic_to_extended_private_key(mnemonic)
        .map_err(|e| JsValue::from_str(&e))?;
    let sk = xkey.secret_key();
    let pk = grin_ext::public_key_from_secret_key(&sk).map_err(|e| JsValue::from_str(&e))?;
    let net = parse_network(network)?;
    let addr = grin_ext::slatepack_address(mnemonic, 0, net).map_err(|e| JsValue::from_str(&e))?;

    let json = format!(
        r#"{{"extended_private_key_hex":"{}","secret_key_hex":"{}","chain_code_hex":"{}","public_key_hex":"{}","slatepack_address":"{}"}}"#,
        xkey.to_hex(),
        hex::encode(sk),
        hex::encode(xkey.chain_code()),
        hex::encode(pk),
        addr,
    );
    Ok(json)
}

/// Derive a slatepack address (Grim/grin-wallet compatible) from a mnemonic.
///
/// `network` must be `"mainnet"` or `"testnet"`.
/// `index` is the address index — 0 is the wallet's default address.
///
/// Returns the bech32-encoded address string (e.g. `"grin1abc..."`).
#[wasm_bindgen]
pub fn grin_slatepack_address(
    mnemonic: &str,
    index: u32,
    network: &str,
) -> Result<String, JsValue> {
    let net = parse_network(network)?;
    grin_ext::slatepack_address(mnemonic, index, net).map_err(|e| JsValue::from_str(&e))
}

/// Derive the receiver's slatepack-address ed25519 secret seed from a
/// mnemonic. Used for signing payment proofs (and any other protocol
/// where the receiver's address-key signs).
///
/// The derived 32-byte secret is the long-lived ed25519 seed that pairs
/// with `grin_slatepack_address(mnemonic, index, ...)`.
#[wasm_bindgen]
pub fn grin_slatepack_address_secret(mnemonic: &str, index: u32) -> Result<String, JsValue> {
    let secret = grin_ext::slatepack_address_ed25519_secret(mnemonic, index)
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(secret))
}

/// Decode a bech32 slatepack address back to its 32-byte ed25519 public
/// key. Inverse of `grin_slatepack_address`. Returns the hex-encoded
/// pubkey — the form `grin_slatepack_pack_encrypted` /
/// `grin_slatepack_encrypt` expects for the recipient.
///
/// Accepts both mainnet (`grin1…`) and testnet (`tgrin1…`) HRPs.
#[wasm_bindgen]
pub fn grin_slatepack_address_to_pubkey_hex(addr: &str) -> Result<String, JsValue> {
    let (pubkey, _network) =
        grin_ext::slatepack_address_to_pubkey(addr).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(pubkey))
}

/// Compute the wallet's `rewind_hash` (32-byte view credential) from the
/// 64-byte extended private key (hex).
///
/// `rewind_hash = blake2b-256(data = compressed_public_root_key (33B), key = [])`.
/// This is the ONLY secret handed to `POST /wallet/grin/scan` — it lets the
/// backend's view-only rewind scan recognize this wallet's outputs WITHOUT
/// exposing spend authority. Returns the 32-byte hash as 64 hex chars.
#[wasm_bindgen]
pub fn grin_rewind_hash(ext_key_hex: &str) -> Result<String, JsValue> {
    let mut ext = [0u8; 64];
    hex::decode_to_slice(ext_key_hex, &mut ext)
        .map_err(|e| JsValue::from_str(&format!("invalid ext_key_hex (expect 128 hex chars): {e}")))?;
    let rh = grin_ext::recovery::rewind_hash(&ext).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(rh))
}

fn parse_network(s: &str) -> Result<grin_ext::Network, JsValue> {
    match s {
        "mainnet" => Ok(grin_ext::Network::Mainnet),
        "testnet" => Ok(grin_ext::Network::Testnet),
        other => Err(JsValue::from_str(&format!(
            "invalid network {other:?}; expected \"mainnet\" or \"testnet\""
        ))),
    }
}
