//! Slatepack ASCII armor — the `BEGINSLATEPACK...ENDSLATEPACK` envelope.
//!
//! Reference: `grin-wallet/libwallet/src/slatepack/armor.rs`. Format:
//!
//! ```text
//! BEGINSLATEPACK. <base58(checksum || payload) word-wrapped>. ENDSLATEPACK.
//! ```
//!
//! - **Checksum:** first 4 bytes of `SHA256(SHA256(payload))`. Detects
//!   transcription errors during copy-paste.
//! - **Payload:** opaque bytes (the `SlatepackBin` binary serialization,
//!   which itself wraps either a plaintext or age-encrypted slate).
//! - **Word wrap:** insert a space every 15 base58 chars, a newline every
//!   200 words (3000 chars). Makes the armored block look like a "wall of
//!   words" that's resilient to messenger auto-formatting.
//!
//! This module implements the outer armor only — turning opaque bytes into
//! a human-shareable string and back. The inner `SlatepackBin` binary
//! format and age encryption are separate pieces.

use sha2::{Digest, Sha256};

/// Header literal that precedes the encoded payload.
pub const HEADER: &str = "BEGINSLATEPACK.";

/// Footer literal that follows the encoded payload.
pub const FOOTER: &str = ". ENDSLATEPACK.";

/// Armored slatepacks are word-wrapped: a space every WORD_LENGTH base58
/// characters, a newline every WORDS_PER_LINE words.
const WORD_LENGTH: usize = 15;
const WORDS_PER_LINE: usize = 200;

/// Whitespace bytes that may appear inside the base58 region (from messenger
/// formatting, quotation marks, etc.). Stripped before decoding.
const WHITESPACE: &[u8] = b">\n\r\t ";

/// Wrap opaque payload bytes in slatepack ASCII armor.
///
/// Returns a human-shareable string starting with `BEGINSLATEPACK.` and
/// ending with `. ENDSLATEPACK.\n`.
pub fn armor(payload: &[u8]) -> String {
    let check = checksum(payload);
    let mut buf = Vec::with_capacity(4 + payload.len());
    buf.extend_from_slice(&check);
    buf.extend_from_slice(payload);
    let encoded = bs58::encode(&buf).into_string();

    let body = format!("{HEADER}{encoded}");
    let formatted = word_wrap(&body);
    format!("{formatted}{FOOTER}\n")
}

/// Unwrap slatepack ASCII armor, returning the inner payload bytes.
///
/// Tolerates surrounding whitespace, quote-prefix characters from messenger
/// quoting (`>`), and arbitrary line breaks. Returns an error if the
/// header/footer is missing, the base58 is malformed, or the checksum
/// doesn't match.
pub fn dearmor(input: &str) -> Result<Vec<u8>, String> {
    let bytes = input.as_bytes();

    // 1. Find the first '.' — everything before it is the header.
    let header_end = bytes
        .iter()
        .position(|b| *b == b'.')
        .ok_or_else(|| "no header terminator '.' found".to_string())?;

    let header = strip_whitespace(&bytes[..header_end]);
    if header != b"BEGINSLATEPACK" {
        return Err(format!(
            "bad armor header: expected 'BEGINSLATEPACK', got '{}'",
            String::from_utf8_lossy(&header)
        ));
    }

    // 2. Find the next '.' — everything between is the base58 payload.
    let payload_start = header_end + 1;
    let payload_end = bytes[payload_start..]
        .iter()
        .position(|b| *b == b'.')
        .ok_or_else(|| "no payload terminator '.' found".to_string())?
        + payload_start;

    let payload_raw = strip_whitespace(&bytes[payload_start..payload_end]);

    // 3. Footer follows.
    let footer_start = payload_end + 1;
    let footer_end = bytes[footer_start..]
        .iter()
        .position(|b| *b == b'.')
        .ok_or_else(|| "no footer terminator '.' found".to_string())?
        + footer_start;

    let footer = strip_whitespace(&bytes[footer_start..footer_end]);
    if footer != b"ENDSLATEPACK" {
        return Err(format!(
            "bad armor footer: expected 'ENDSLATEPACK', got '{}'",
            String::from_utf8_lossy(&footer)
        ));
    }

    // 4. Base58 decode.
    let decoded = bs58::decode(&payload_raw)
        .into_vec()
        .map_err(|e| format!("base58 decode failed: {e}"))?;
    if decoded.len() < 4 {
        return Err(format!("decoded payload too short: {} bytes", decoded.len()));
    }

    // 5. Verify checksum.
    let (check, payload) = decoded.split_at(4);
    let expected = checksum(payload);
    if check != expected {
        return Err("checksum mismatch — armored slatepack was corrupted in transit".to_string());
    }

    Ok(payload.to_vec())
}

/// First 4 bytes of `SHA256(SHA256(payload))`.
fn checksum(payload: &[u8]) -> [u8; 4] {
    let first = Sha256::digest(payload);
    let second = Sha256::digest(first);
    let mut out = [0u8; 4];
    out.copy_from_slice(&second[..4]);
    out
}

/// Word-wrap a string: insert a space every WORD_LENGTH chars and a newline
/// every WORDS_PER_LINE words.
fn word_wrap(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + input.len() / WORD_LENGTH);
    for (i, c) in input.chars().enumerate() {
        if i != 0 && i % WORD_LENGTH == 0 {
            if i % (WORD_LENGTH * WORDS_PER_LINE) == 0 {
                out.push('\n');
            } else {
                out.push(' ');
            }
        }
        out.push(c);
    }
    out
}

/// Filter out whitespace + quote-prefix bytes from a slice.
fn strip_whitespace(bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .copied()
        .filter(|b| !WHITESPACE.contains(b))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn armor_starts_with_header_ends_with_footer() {
        let payload = b"hello world";
        let armored = armor(payload);
        assert!(armored.starts_with(HEADER), "got: {armored}");
        assert!(armored.trim_end().ends_with(FOOTER.trim()), "got: {armored}");
    }

    #[test]
    fn armor_dearmor_round_trip_short_payload() {
        let payload = b"slatepack-test-payload-bytes";
        let armored = armor(payload);
        let recovered = dearmor(&armored).expect("dearmor succeeds");
        assert_eq!(recovered, payload);
    }

    #[test]
    fn armor_dearmor_round_trip_binary_payload() {
        // Random-looking 256 byte payload — exercises base58 encoding length.
        let payload: Vec<u8> = (0..=255).collect();
        let armored = armor(&payload);
        let recovered = dearmor(&armored).expect("dearmor succeeds for 256-byte payload");
        assert_eq!(recovered, payload);
    }

    #[test]
    fn armor_word_wraps_at_15_chars() {
        // Long payload to ensure we hit the word-wrap boundary.
        let payload: Vec<u8> = (0..200).map(|i| (i & 0xff) as u8).collect();
        let armored = armor(&payload);
        // The base58 region (between the header's '.' and the footer's '.')
        // should contain spaces inserted every 15 chars.
        let body_start = armored.find('.').unwrap() + 1;
        let body_end = armored[body_start..].find('.').unwrap() + body_start;
        let body = &armored[body_start..body_end];
        assert!(
            body.contains(' '),
            "expected word-wrap spaces in armored body, got: {body}"
        );
    }

    #[test]
    fn dearmor_tolerates_surrounding_whitespace_and_quotes() {
        let payload = b"messaging-app-test";
        let armored = armor(payload);
        // Simulate quotation marks and weird formatting from a messenger.
        let mangled = format!("> {} \n>\n", armored.replace('\n', "\n> "));
        let recovered = dearmor(&mangled).expect("dearmor handles quoted/wrapped input");
        assert_eq!(recovered, payload);
    }

    #[test]
    fn dearmor_rejects_corrupted_payload() {
        let payload = b"will-be-corrupted";
        let armored = armor(payload);

        // Flip a character in the base58 region.
        let mut chars: Vec<char> = armored.chars().collect();
        let header_end = armored.find('.').unwrap();
        // Pick a character a few chars after the header — guaranteed to be
        // base58, not punctuation.
        let pos = header_end + 5;
        chars[pos] = if chars[pos] == 'A' { 'B' } else { 'A' };
        let mangled: String = chars.into_iter().collect();

        let result = dearmor(&mangled);
        assert!(result.is_err(), "expected dearmor to reject corrupted input");
    }

    #[test]
    fn dearmor_rejects_missing_header() {
        let mangled = "no header here. some-payload. ENDSLATEPACK.\n";
        let result = dearmor(mangled);
        assert!(result.is_err());
    }

    #[test]
    fn dearmor_rejects_missing_footer() {
        // Valid header + valid base58 but wrong footer.
        let mangled = "BEGINSLATEPACK.SomePayload. WRONGFOOTER.\n";
        let result = dearmor(mangled);
        assert!(result.is_err());
    }

    /// Real slatepack fixture from grin-wallet/api/src/owner_rpc.rs.
    /// The doc-test uses this as the example output of `init_send_tx`.
    /// We verify our dearmor accepts it and our re-armor produces a
    /// round-trip-equivalent string (different whitespace, same payload).
    const FIXTURE: &str = "BEGINSLATEPACK. xyfzdULuUuM5r3R kS68aywyCuYssPs Jf1JbvnBcK6NDDo ajiGAgh2SPx4t49 xtKuJE3BZCcSEue ksecMmbSoV2DQbX gGcmJniP9UadcmR N1KSc5FBhwAaUjy LXeYDP7EV7Cmsj4 pLaJdZTJTQbccUH 2zG8QTgoEiEWP5V T6rKst1TibmDAFm RRVHYDtskdYJb5G krqfpgN7RjvPfpm Z5ZFyz6ipAt5q9T 2HCjrTxkHdVi9js 22tr2Lx6iXT5vm8 JL6HhjwyFrSaEmN AjsBE8jgiaAABA6 GGZKwcXeXToMfRt nL9DeX1. ENDSLATEPACK.";

    #[test]
    fn dearmor_accepts_real_grin_wallet_fixture() {
        let payload = dearmor(FIXTURE).expect("real fixture decodes");
        // Don't try to interpret the inner bytes — we don't yet have the
        // SlatepackBin binary format implemented. Just verify the checksum
        // round-trip: re-arm those bytes and dearm again must round-trip.
        let re_armored = armor(&payload);
        let again = dearmor(&re_armored).expect("re-armored output decodes");
        assert_eq!(payload, again, "armor/dearmor must be lossless");
    }
}
