//! WASM exports for Grin / Mimblewimble functionality.
//!
//! Each export is a thin wrapper over a `grin-ext` function, returning JSON
//! for ergonomic consumption from TypeScript. The shape of the JSON should
//! match what `smirk-extension/src/lib/grin/wallet.ts` returns from the
//! existing MWC-vendored stack so that the TS migration in a future session
//! is a drop-in replacement.

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

/// grin-ext crate version. Useful for runtime version sanity checks.
#[wasm_bindgen]
pub fn grin_ext_version() -> String {
    grin_ext::VERSION.to_string()
}
