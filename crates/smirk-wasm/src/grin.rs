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

fn parse_network(s: &str) -> Result<grin_ext::Network, JsValue> {
    match s {
        "mainnet" => Ok(grin_ext::Network::Mainnet),
        "testnet" => Ok(grin_ext::Network::Testnet),
        other => Err(JsValue::from_str(&format!(
            "invalid network {other:?}; expected \"mainnet\" or \"testnet\""
        ))),
    }
}

// =============================================================================
// Schnorr signatures
// =============================================================================

/// Sign a 32-byte message hash with a Grin-style Schnorr signature.
///
/// `secret_key_hex` and `secret_nonce_hex` are 32-byte scalars (64 hex chars).
/// `message_hex` is the 32-byte message digest (64 hex chars).
///
/// Returns the 64-byte compact signature as 128 hex chars.
///
/// **The caller is responsible for ensuring the secret_nonce is fresh**
/// (CSPRNG-derived, never-reused). Reusing a nonce across messages with the
/// same secret key reveals the secret key.
#[wasm_bindgen]
pub fn grin_schnorr_sign(
    secret_key_hex: &str,
    secret_nonce_hex: &str,
    message_hex: &str,
) -> Result<String, JsValue> {
    let mut sk = [0u8; 32];
    hex::decode_to_slice(secret_key_hex, &mut sk)
        .map_err(|e| JsValue::from_str(&format!("invalid secret_key_hex: {e}")))?;

    let mut nonce = [0u8; 32];
    hex::decode_to_slice(secret_nonce_hex, &mut nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid secret_nonce_hex: {e}")))?;

    let mut msg = [0u8; 32];
    hex::decode_to_slice(message_hex, &mut msg)
        .map_err(|e| JsValue::from_str(&format!("invalid message_hex: {e}")))?;

    let sig = grin_ext::sign_with_nonce(&sk, &nonce, &msg).map_err(|e| JsValue::from_str(&e))?;
    Ok(sig.to_hex())
}

/// Verify a Grin-style Schnorr signature.
///
/// `signature_hex` is 64 bytes (128 hex chars). `message_hex` is the 32-byte
/// message digest. `public_key_hex` is the 33-byte compressed secp256k1
/// public key.
///
/// Returns `true` if the signature is valid, `false` otherwise. Throws on
/// malformed inputs.
#[wasm_bindgen]
pub fn grin_schnorr_verify(
    signature_hex: &str,
    message_hex: &str,
    public_key_hex: &str,
) -> Result<bool, JsValue> {
    let mut sig_bytes = [0u8; 64];
    hex::decode_to_slice(signature_hex, &mut sig_bytes)
        .map_err(|e| JsValue::from_str(&format!("invalid signature_hex: {e}")))?;
    let sig = grin_ext::Signature::from_bytes(sig_bytes);

    let mut msg = [0u8; 32];
    hex::decode_to_slice(message_hex, &mut msg)
        .map_err(|e| JsValue::from_str(&format!("invalid message_hex: {e}")))?;

    let mut pk = [0u8; 33];
    hex::decode_to_slice(public_key_hex, &mut pk)
        .map_err(|e| JsValue::from_str(&format!("invalid public_key_hex: {e}")))?;

    grin_ext::schnorr_verify(&sig, &msg, &pk).map_err(|e| JsValue::from_str(&e))
}

// =============================================================================
// Slate v4 wire format
// =============================================================================

/// Parse a Grin slate v4 JSON string and re-serialize it.
///
/// Useful as a slate validator: any slate that round-trips successfully is
/// a structurally valid v4 slate. Returns the canonicalized JSON
/// (whitespace-stripped, default-fields-omitted).
///
/// Throws on malformed input.
#[wasm_bindgen]
pub fn grin_slate_round_trip(slate_json: &str) -> Result<String, JsValue> {
    let slate = grin_ext::parse_slate_v4(slate_json).map_err(|e| JsValue::from_str(&e))?;
    grin_ext::serialize_slate_v4(&slate).map_err(|e| JsValue::from_str(&e))
}

/// Extract a small summary from a slate v4 JSON for UI display.
///
/// Returns JSON: `{ "id": "...", "state": "S1", "amount": "0", "fee": "0",
/// "num_participants": 2, "num_signed": 0 }`.
#[wasm_bindgen]
pub fn grin_slate_summary(slate_json: &str) -> Result<String, JsValue> {
    let slate = grin_ext::parse_slate_v4(slate_json).map_err(|e| JsValue::from_str(&e))?;

    let state_str = match slate.sta {
        grin_ext::SlateStateV4::Unknown => "NA",
        grin_ext::SlateStateV4::Standard1 => "S1",
        grin_ext::SlateStateV4::Standard2 => "S2",
        grin_ext::SlateStateV4::Standard3 => "S3",
        grin_ext::SlateStateV4::Invoice1 => "I1",
        grin_ext::SlateStateV4::Invoice2 => "I2",
        grin_ext::SlateStateV4::Invoice3 => "I3",
    };
    let num_signed = slate.sigs.iter().filter(|s| s.part.is_some()).count();

    let json = format!(
        r#"{{"id":"{}","state":"{}","amount":"{}","fee":"{}","num_participants":{},"num_signed":{}}}"#,
        slate.id, state_str, slate.amt, slate.fee, slate.num_parts, num_signed,
    );
    Ok(json)
}

// =============================================================================
// Bulletproofs + Pedersen commitments
// =============================================================================

/// Create a Pedersen commitment to `(value, blinding_factor)`.
///
/// `blinding_factor_hex` is 32 bytes (64 hex chars).
/// Returns 33 bytes (66 hex chars) — the commitment.
#[wasm_bindgen]
pub fn grin_pedersen_commit(value: u64, blinding_factor_hex: &str) -> Result<String, JsValue> {
    let mut blind = [0u8; 32];
    hex::decode_to_slice(blinding_factor_hex, &mut blind)
        .map_err(|e| JsValue::from_str(&format!("invalid blinding_factor_hex: {e}")))?;
    let commit = grin_ext::pedersen_commit(value, &blind).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(commit))
}

/// Create a Bulletproof range proof.
///
/// All `_hex` arguments are 32-byte scalars (64 hex chars). `value` is in
/// nanogrin. `rewind_nonce` will allow the receiver to recover the value.
/// `private_nonce` should be a fresh CSPRNG-derived secret known only to
/// the prover.
///
/// Returns the proof bytes as hex (typically ~676 bytes / 1352 hex chars
/// for a single 64-bit range).
#[wasm_bindgen]
pub fn grin_bullet_proof_create(
    value: u64,
    blinding_factor_hex: &str,
    rewind_nonce_hex: &str,
    private_nonce_hex: &str,
) -> Result<String, JsValue> {
    let mut blind = [0u8; 32];
    hex::decode_to_slice(blinding_factor_hex, &mut blind)
        .map_err(|e| JsValue::from_str(&format!("invalid blinding_factor_hex: {e}")))?;
    let mut rewind = [0u8; 32];
    hex::decode_to_slice(rewind_nonce_hex, &mut rewind)
        .map_err(|e| JsValue::from_str(&format!("invalid rewind_nonce_hex: {e}")))?;
    let mut private = [0u8; 32];
    hex::decode_to_slice(private_nonce_hex, &mut private)
        .map_err(|e| JsValue::from_str(&format!("invalid private_nonce_hex: {e}")))?;

    let proof = grin_ext::bullet_proof_create(value, &blind, &rewind, &private)
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(proof))
}

/// Verify a Bulletproof against a Pedersen commitment.
///
/// `commit_hex` is the 33-byte commitment (66 hex chars).
/// `proof_hex` is the variable-length proof bytes (hex).
/// Returns `true` if valid, `false` if invalid.
#[wasm_bindgen]
pub fn grin_bullet_proof_verify(commit_hex: &str, proof_hex: &str) -> Result<bool, JsValue> {
    let mut commit = [0u8; 33];
    hex::decode_to_slice(commit_hex, &mut commit)
        .map_err(|e| JsValue::from_str(&format!("invalid commit_hex: {e}")))?;
    let proof_bytes = hex::decode(proof_hex)
        .map_err(|e| JsValue::from_str(&format!("invalid proof_hex: {e}")))?;
    grin_ext::bullet_proof_verify(&commit, &proof_bytes).map_err(|e| JsValue::from_str(&e))
}

/// Rewind a Bulletproof, recovering the committed value (and a derived
/// blinding factor for the recipient to use later).
///
/// Returns JSON: `{ "value": "...", "blinding_factor_hex": "..." }` on
/// successful rewind, or `null` if the nonce doesn't match the proof.
#[wasm_bindgen]
pub fn grin_bullet_proof_rewind(
    commit_hex: &str,
    rewind_nonce_hex: &str,
    proof_hex: &str,
) -> Result<String, JsValue> {
    let mut commit = [0u8; 33];
    hex::decode_to_slice(commit_hex, &mut commit)
        .map_err(|e| JsValue::from_str(&format!("invalid commit_hex: {e}")))?;
    let mut nonce = [0u8; 32];
    hex::decode_to_slice(rewind_nonce_hex, &mut nonce)
        .map_err(|e| JsValue::from_str(&format!("invalid rewind_nonce_hex: {e}")))?;
    let proof_bytes = hex::decode(proof_hex)
        .map_err(|e| JsValue::from_str(&format!("invalid proof_hex: {e}")))?;

    match grin_ext::bullet_proof_rewind(&commit, &nonce, &proof_bytes)
        .map_err(|e| JsValue::from_str(&e))?
    {
        Some((value, blinding)) => Ok(format!(
            r#"{{"value":"{}","blinding_factor_hex":"{}"}}"#,
            value,
            hex::encode(blinding)
        )),
        None => Ok("null".to_string()),
    }
}

/// grin-ext crate version. Useful for runtime version sanity checks.
#[wasm_bindgen]
pub fn grin_ext_version() -> String {
    grin_ext::VERSION.to_string()
}
