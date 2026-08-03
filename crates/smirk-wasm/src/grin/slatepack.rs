//! Slatepack encoding: ASCII armor + binary `SlatepackBin` format + age
//! encryption (mode = 1).
//!
//! Three layers:
//!
//! 1. **ASCII armor** (`BEGINSLATEPACK…ENDSLATEPACK`): base58 of inner
//!    binary, with checksum and word-wrap. Tolerant of messenger quote
//!    prefixes (`>`) and arbitrary line breaks.
//! 2. **`SlatepackBin`**: the binary structure inside the armor: version,
//!    mode (plain or encrypted), optional sender, payload.
//! 3. **age encryption** (mode = 1): payload encrypted to recipient's
//!    slatepack-address ed25519 pubkey via X25519 ECDH. Pure-Rust
//!    ChaCha20-Poly1305 + scrypt.

use wasm_bindgen::prelude::*;

// ----- ASCII armor -----

/// Wrap opaque bytes in slatepack ASCII armor.
///
/// `payload_hex` is the hex-encoded inner payload (typically the binary
/// SlatepackBin serialization, but treated as opaque here). Returns the
/// human-shareable string `BEGINSLATEPACK. <base58> . ENDSLATEPACK.\n`.
#[wasm_bindgen]
pub fn grin_slatepack_armor(payload_hex: &str) -> Result<String, JsValue> {
    let payload = hex::decode(payload_hex)
        .map_err(|e| JsValue::from_str(&format!("invalid payload_hex: {e}")))?;
    Ok(grin_ext::slatepack_armor(&payload))
}

/// Unwrap slatepack ASCII armor.
///
/// Tolerates surrounding whitespace, messenger quote prefixes (`>`), and
/// arbitrary line breaks. Verifies the embedded SHA256-double-hash
/// checksum. Returns the inner payload as hex.
///
/// Throws on malformed input (missing header/footer, base58 decode failure,
/// or checksum mismatch).
#[wasm_bindgen]
pub fn grin_slatepack_dearmor(armored: &str) -> Result<String, JsValue> {
    let payload = grin_ext::slatepack_dearmor(armored).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(payload))
}

// ----- SlatepackBin (binary inside the armor) -----

/// Wrap an inner payload in a plaintext-mode SlatepackBin (binary structure
/// inside the armor) and return the binary serialization.
///
/// `inner_payload_hex` is the slate or other inner bytes (typically a
/// binary-serialized SlateV4). `sender` is an optional bech32 slatepack
/// address (e.g. `grin1abc...`). Pass `null` / empty string for none.
///
/// Returns the SlatepackBin binary as hex.
#[wasm_bindgen]
pub fn grin_slatepack_bin_encode_plain(
    inner_payload_hex: &str,
    sender: Option<String>,
) -> Result<String, JsValue> {
    let payload = hex::decode(inner_payload_hex)
        .map_err(|e| JsValue::from_str(&format!("invalid inner_payload_hex: {e}")))?;
    let sender = sender.filter(|s| !s.is_empty());
    let sp = grin_ext::SlatepackBin::plain(payload, sender);
    Ok(hex::encode(sp.to_bytes()))
}

/// Parse a SlatepackBin binary (the structure that lives inside slatepack
/// armor) and return its components as JSON.
///
/// Returns JSON: `{ "version": "1.0", "mode": "plain" | "encrypted",
/// "sender": "grin1..." | null, "payload_hex": "..." }`.
#[wasm_bindgen]
pub fn grin_slatepack_bin_decode(bin_hex: &str) -> Result<String, JsValue> {
    let bytes =
        hex::decode(bin_hex).map_err(|e| JsValue::from_str(&format!("invalid bin_hex: {e}")))?;
    let sp = grin_ext::SlatepackBin::from_bytes(&bytes).map_err(|e| JsValue::from_str(&e))?;

    let mode_str = match sp.mode {
        grin_ext::SlatepackMode::Plain => "plain",
        grin_ext::SlatepackMode::Encrypted => "encrypted",
    };
    let sender_field = match &sp.sender {
        Some(s) => format!(r#""{}""#, s),
        None => "null".to_string(),
    };

    let json = format!(
        r#"{{"version":"{}.{}","mode":"{}","sender":{},"payload_hex":"{}"}}"#,
        sp.version.major,
        sp.version.minor,
        mode_str,
        sender_field,
        hex::encode(&sp.payload),
    );
    Ok(json)
}

/// One-call helper: take an inner payload (e.g. a binary slate), wrap it in
/// a plaintext SlatepackBin, and ASCII-armor the result.
///
/// Returns the human-shareable `BEGINSLATEPACK...ENDSLATEPACK` string.
#[wasm_bindgen]
pub fn grin_slatepack_pack_plain(
    inner_payload_hex: &str,
    sender: Option<String>,
) -> Result<String, JsValue> {
    let payload = hex::decode(inner_payload_hex)
        .map_err(|e| JsValue::from_str(&format!("invalid inner_payload_hex: {e}")))?;
    let sender = sender.filter(|s| !s.is_empty());
    let sp = grin_ext::SlatepackBin::plain(payload, sender);
    Ok(grin_ext::slatepack_armor(&sp.to_bytes()))
}

/// One-call helper: take an armored slatepack string and return JSON with
/// the parsed inner SlatepackBin fields. Same shape as
/// `grin_slatepack_bin_decode`.
#[wasm_bindgen]
pub fn grin_slatepack_unpack(armored: &str) -> Result<String, JsValue> {
    let bin_bytes = grin_ext::slatepack_dearmor(armored).map_err(|e| JsValue::from_str(&e))?;
    grin_slatepack_bin_decode(&hex::encode(bin_bytes))
}

// ----- age encryption (mode = 1) -----

/// Encrypt a payload to a recipient slatepack address.
///
/// `recipient_pubkey_hex` is the 32-byte ed25519 public key from inside the
/// recipient's bech32 slatepack address (use [`super::keys::grin_slatepack_address`]
/// in reverse; TODO: bech32-decode helper) or the raw 32-byte hex. Returns
/// the encrypted bytes that go into `SlatepackBin.payload` when mode = 1.
#[wasm_bindgen]
pub fn grin_slatepack_encrypt(
    payload_hex: &str,
    recipient_pubkey_hex: &str,
) -> Result<String, JsValue> {
    let payload = hex::decode(payload_hex)
        .map_err(|e| JsValue::from_str(&format!("invalid payload_hex: {e}")))?;
    let mut pk = [0u8; 32];
    hex::decode_to_slice(recipient_pubkey_hex, &mut pk)
        .map_err(|e| JsValue::from_str(&format!("invalid recipient_pubkey_hex: {e}")))?;
    let encrypted =
        grin_ext::encrypt_to_recipient(&payload, &pk).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(encrypted))
}

/// Decrypt an age-encrypted slatepack payload using the recipient's
/// ed25519 secret key (32-byte hex).
///
/// Returns the inner cleartext payload as hex.
#[wasm_bindgen]
pub fn grin_slatepack_decrypt(
    encrypted_payload_hex: &str,
    secret_key_hex: &str,
) -> Result<String, JsValue> {
    let encrypted = hex::decode(encrypted_payload_hex)
        .map_err(|e| JsValue::from_str(&format!("invalid encrypted_payload_hex: {e}")))?;
    let mut sk = [0u8; 32];
    hex::decode_to_slice(secret_key_hex, &mut sk)
        .map_err(|e| JsValue::from_str(&format!("invalid secret_key_hex: {e}")))?;
    let plaintext =
        grin_ext::decrypt_with_secret(&encrypted, &sk).map_err(|e| JsValue::from_str(&e))?;
    Ok(hex::encode(plaintext))
}

/// One-call helper: encrypt a payload to a recipient, wrap in a
/// SlatepackBin (mode=1), and ASCII-armor the result.
///
/// Returns the human-shareable `BEGINSLATEPACK...ENDSLATEPACK` string.
#[wasm_bindgen]
pub fn grin_slatepack_pack_encrypted(
    inner_payload_hex: &str,
    sender: Option<String>,
    recipient_pubkey_hex: &str,
) -> Result<String, JsValue> {
    let payload = hex::decode(inner_payload_hex)
        .map_err(|e| JsValue::from_str(&format!("invalid inner_payload_hex: {e}")))?;
    let mut pk = [0u8; 32];
    hex::decode_to_slice(recipient_pubkey_hex, &mut pk)
        .map_err(|e| JsValue::from_str(&format!("invalid recipient_pubkey_hex: {e}")))?;
    let sender = sender.filter(|s| !s.is_empty());

    let bin =
        grin_ext::pack_encrypted(&payload, sender, &pk).map_err(|e| JsValue::from_str(&e))?;
    Ok(grin_ext::slatepack_armor(&bin.to_bytes()))
}

/// One-call helper: dearmor + parse a SlatepackBin + decrypt the payload
/// using the receiver's ed25519 secret. Works for both plaintext and
/// encrypted slatepacks (returns the inner payload hex either way).
///
/// Returns JSON: `{ "version": "1.0", "mode": "plain" | "encrypted",
/// "sender": "grin1..." | null, "payload_hex": "..." }`.
#[wasm_bindgen]
pub fn grin_slatepack_unpack_with_secret(
    armored: &str,
    secret_key_hex: &str,
) -> Result<String, JsValue> {
    let mut sk = [0u8; 32];
    hex::decode_to_slice(secret_key_hex, &mut sk)
        .map_err(|e| JsValue::from_str(&format!("invalid secret_key_hex: {e}")))?;

    let bin_bytes = grin_ext::slatepack_dearmor(armored).map_err(|e| JsValue::from_str(&e))?;
    let bin = grin_ext::SlatepackBin::from_bytes(&bin_bytes).map_err(|e| JsValue::from_str(&e))?;

    let mode_str = match bin.mode {
        grin_ext::SlatepackMode::Plain => "plain",
        grin_ext::SlatepackMode::Encrypted => "encrypted",
    };
    let sender_field = match &bin.sender {
        Some(s) => format!(r#""{}""#, s),
        None => "null".to_string(),
    };

    let inner = match bin.mode {
        grin_ext::SlatepackMode::Plain => bin.payload.clone(),
        grin_ext::SlatepackMode::Encrypted => {
            grin_ext::unpack_encrypted(&bin, &sk).map_err(|e| JsValue::from_str(&e))?
        }
    };

    let json = format!(
        r#"{{"version":"{}.{}","mode":"{}","sender":{},"payload_hex":"{}"}}"#,
        bin.version.major,
        bin.version.minor,
        mode_str,
        sender_field,
        hex::encode(inner),
    );
    Ok(json)
}
