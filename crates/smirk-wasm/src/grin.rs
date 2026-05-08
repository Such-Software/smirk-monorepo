//! WASM exports for Grin / Mimblewimble functionality.
//!
//! Each export is a thin wrapper over a `grin-ext` function, returning JSON
//! for ergonomic consumption from TypeScript. The JSON shape mirrors the
//! return values of the existing `smirk-extension/src/lib/grin/wallet.ts`
//! functions so the eventual TS migration is a drop-in replacement.

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
/// wrapper that bundles `grin_derive_extended_key` + `grin_secp256k1_public_key`.
///
/// Returns JSON:
/// ```text
/// {
///   "extended_private_key_hex": "...",  // 128 hex chars (64 bytes)
///   "secret_key_hex": "...",            //  64 hex chars (32 bytes)
///   "chain_code_hex": "...",            //  64 hex chars (32 bytes)
///   "public_key_hex": "..."             //  66 hex chars (33 bytes, compressed)
/// }
/// ```
#[wasm_bindgen]
pub fn grin_derive_keys(mnemonic: &str) -> Result<String, JsValue> {
    let xkey = grin_ext::mnemonic_to_extended_private_key(mnemonic)
        .map_err(|e| JsValue::from_str(&e))?;
    let sk = xkey.secret_key();
    let pk = grin_ext::public_key_from_secret_key(&sk).map_err(|e| JsValue::from_str(&e))?;

    let json = format!(
        r#"{{"extended_private_key_hex":"{}","secret_key_hex":"{}","chain_code_hex":"{}","public_key_hex":"{}"}}"#,
        xkey.to_hex(),
        hex::encode(sk),
        hex::encode(xkey.chain_code()),
        hex::encode(pk),
    );
    Ok(json)
}

/// grin-ext crate version. Useful for runtime version sanity checks.
#[wasm_bindgen]
pub fn grin_ext_version() -> String {
    grin_ext::VERSION.to_string()
}
