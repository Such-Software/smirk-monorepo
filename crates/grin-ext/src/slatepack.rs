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

// =============================================================================
// SlatepackBin — the binary structure inside the armor
// =============================================================================
//
// Reference: `grin-wallet/libwallet/src/slatepack/types.rs::impl Writeable for SlatepackBin`.
// On-the-wire layout (all multi-byte ints big-endian):
//
//   version    : u8 major, u8 minor              (2 bytes)
//   mode       : u8                                (1 byte; 0 = plain, 1 = age-encrypted)
//   opt_flags  : u16                               (2 bytes; bit 0 = sender present)
//   opt_len    : u32                               (4 bytes; total bytes of optional-field region)
//   [sender]   : present iff opt_flags bit 0:      (u8 len + len bytes of ASCII bech32)
//   [unknown]  : remaining (opt_len - sender_size) bytes (forward-compat skip region)
//   payload_len: u32                               (4 bytes)
//   payload    : raw bytes
//
// We always emit version 1.0. `mode` is 0 (plain) for now; `mode = 1` (age
// encryption) is a follow-up commit alongside the encryption module.

/// Slatepack version. Currently always 1.0 in production grin-wallet output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlatepackVersion {
    pub major: u8,
    pub minor: u8,
}

impl SlatepackVersion {
    pub const V1_0: Self = Self { major: 1, minor: 0 };
}

/// Slatepack delivery mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SlatepackMode {
    /// `mode = 0` — payload is a binary slate, unencrypted.
    Plain = 0,
    /// `mode = 1` — payload is age-encrypted to one or more recipients.
    /// Encryption support is not yet implemented in this crate.
    Encrypted = 1,
}

/// A `SlatepackBin` — the binary structure that lives inside the
/// `BEGINSLATEPACK...ENDSLATEPACK` armor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlatepackBin {
    pub version: SlatepackVersion,
    pub mode: SlatepackMode,
    /// Optional sender slatepack address, in human-readable bech32 form
    /// (e.g. `grin1abc...`). The binary serialization stores it as-is
    /// (length-prefixed ASCII), not re-encoded.
    pub sender: Option<String>,
    /// Inner payload — either a binary slate (mode=Plain) or age-encrypted
    /// blob (mode=Encrypted). Treated as opaque bytes here.
    pub payload: Vec<u8>,
}

impl SlatepackBin {
    /// Construct a plaintext-mode SlatepackBin wrapping the given payload.
    pub fn plain(payload: Vec<u8>, sender: Option<String>) -> Self {
        Self {
            version: SlatepackVersion::V1_0,
            mode: SlatepackMode::Plain,
            sender,
            payload,
        }
    }

    /// Serialize to the binary format that goes inside the armor.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(2 + 1 + 2 + 4 + self.payload.len() + 64);

        // Version
        out.push(self.version.major);
        out.push(self.version.minor);

        // Mode
        out.push(self.mode as u8);

        // opt_flags + opt_len
        let (opt_flags, opt_bytes): (u16, Vec<u8>) = match &self.sender {
            Some(addr) => {
                let mut buf = Vec::with_capacity(1 + addr.len());
                // grin-wallet caps the address-length prefix at 255 bytes;
                // .min(255) below makes the truncation explicit.
                #[allow(clippy::cast_possible_truncation)]
                let len = addr.len().min(255) as u8;
                buf.push(len);
                buf.extend_from_slice(&addr.as_bytes()[..len as usize]);
                (0x0001, buf)
            }
            None => (0x0000, Vec::new()),
        };
        out.extend_from_slice(&opt_flags.to_be_bytes());
        // Slatepack length fields are u32 BE per the wire format. Real
        // slatepack payloads are always well under 2^32 bytes, so the
        // cast is safe in practice; if a >4GB sender address or payload
        // ever showed up we'd have far worse problems.
        #[allow(clippy::cast_possible_truncation)]
        out.extend_from_slice(&(opt_bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(&opt_bytes);

        // payload (length-prefixed)
        #[allow(clippy::cast_possible_truncation)]
        out.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        out.extend_from_slice(&self.payload);

        out
    }

    /// Parse from the binary format.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        let mut cursor = ByteCursor::new(bytes);

        let major = cursor.read_u8()?;
        let minor = cursor.read_u8()?;
        let version = SlatepackVersion { major, minor };

        let mode_byte = cursor.read_u8()?;
        let mode = match mode_byte {
            0 => SlatepackMode::Plain,
            1 => SlatepackMode::Encrypted,
            other => return Err(format!("unknown slatepack mode: {other}")),
        };

        let opt_flags = cursor.read_u16_be()?;
        let opt_len = cursor.read_u32_be()? as usize;

        let mut consumed = 0usize;
        let sender = if opt_flags & 0x01 != 0 {
            let addr_len = cursor.read_u8()? as usize;
            consumed += 1 + addr_len;
            let addr_bytes = cursor.read_bytes(addr_len)?;
            Some(
                core::str::from_utf8(addr_bytes)
                    .map_err(|e| format!("sender address is not UTF-8: {e}"))?
                    .to_string(),
            )
        } else {
            None
        };

        // Skip any unknown future-fields padding inside opt region.
        if opt_len > consumed {
            cursor.skip(opt_len - consumed)?;
        }

        let payload_len = cursor.read_u32_be()? as usize;
        let payload = cursor.read_bytes(payload_len)?.to_vec();

        Ok(Self {
            version,
            mode,
            sender,
            payload,
        })
    }
}

/// Minimal byte-cursor helper for fixed-format binary parsing.
struct ByteCursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> ByteCursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn ensure(&self, n: usize) -> Result<(), String> {
        if self.pos + n > self.data.len() {
            Err(format!(
                "unexpected end of input at offset {}: needed {n} more bytes, have {}",
                self.pos,
                self.data.len() - self.pos
            ))
        } else {
            Ok(())
        }
    }
    fn read_u8(&mut self) -> Result<u8, String> {
        self.ensure(1)?;
        let v = self.data[self.pos];
        self.pos += 1;
        Ok(v)
    }
    fn read_u16_be(&mut self) -> Result<u16, String> {
        self.ensure(2)?;
        let v = u16::from_be_bytes([self.data[self.pos], self.data[self.pos + 1]]);
        self.pos += 2;
        Ok(v)
    }
    fn read_u32_be(&mut self) -> Result<u32, String> {
        self.ensure(4)?;
        let mut buf = [0u8; 4];
        buf.copy_from_slice(&self.data[self.pos..self.pos + 4]);
        self.pos += 4;
        Ok(u32::from_be_bytes(buf))
    }
    fn read_bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        self.ensure(n)?;
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    fn skip(&mut self, n: usize) -> Result<(), String> {
        self.ensure(n)?;
        self.pos += n;
        Ok(())
    }
}

// =============================================================================
// Outer ASCII armor
// =============================================================================

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
        let payload: Vec<u8> = (0..200u8).collect();
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
        let re_armored = armor(&payload);
        let again = dearmor(&re_armored).expect("re-armored output decodes");
        assert_eq!(payload, again, "armor/dearmor must be lossless");
    }

    // =========================================================================
    // SlatepackBin tests
    // =========================================================================

    #[test]
    fn slatepack_bin_plain_round_trip_no_sender() {
        let inner_payload = b"this is the inner slate or whatever".to_vec();
        let sp = SlatepackBin::plain(inner_payload.clone(), None);
        let bytes = sp.to_bytes();
        let parsed = SlatepackBin::from_bytes(&bytes).expect("parses");
        assert_eq!(parsed, sp);
        assert_eq!(parsed.payload, inner_payload);
        assert!(parsed.sender.is_none());
    }

    #[test]
    fn slatepack_bin_plain_round_trip_with_sender() {
        let inner_payload = b"slate-bytes-here".to_vec();
        let sender = "grin1a9q4mvh8vn8gyfkfg67nrn0k4ampj9u8z99w5k5p20n0a2vkanms9ccr7x".to_string();
        let sp = SlatepackBin::plain(inner_payload.clone(), Some(sender.clone()));
        let bytes = sp.to_bytes();
        let parsed = SlatepackBin::from_bytes(&bytes).expect("parses");
        assert_eq!(parsed, sp);
        assert_eq!(parsed.sender.as_deref(), Some(sender.as_str()));
    }

    #[test]
    fn slatepack_bin_version_is_v1_0_by_default() {
        let sp = SlatepackBin::plain(vec![0u8; 5], None);
        let bytes = sp.to_bytes();
        assert_eq!(bytes[0], 1, "major version");
        assert_eq!(bytes[1], 0, "minor version");
        assert_eq!(bytes[2], 0, "mode = plain");
    }

    #[test]
    fn slatepack_bin_rejects_unknown_mode() {
        // Construct a malformed bin: version 1.0, mode = 99, no optional
        // fields, empty payload.
        let bytes = vec![
            0x01, 0x00, // version 1.0
            99,   // bogus mode
            0x00, 0x00, // opt_flags = 0
            0x00, 0x00, 0x00, 0x00, // opt_len = 0
            0x00, 0x00, 0x00, 0x00, // payload_len = 0
        ];
        let result = SlatepackBin::from_bytes(&bytes);
        assert!(result.is_err());
    }

    #[test]
    fn slatepack_bin_real_grin_wallet_fixture_parses() {
        // Take the real grin-wallet fixture, dearmor it to get the
        // SlatepackBin bytes, then parse them as a SlatepackBin. This
        // is the highest-confidence test that our binary format matches.
        let bin_bytes = dearmor(FIXTURE).expect("fixture dearmor");
        let parsed = SlatepackBin::from_bytes(&bin_bytes).expect("real grin-wallet SlatepackBin parses");

        // Sanity: version is 1.0; mode is one of the two valid values.
        // (Real slatepacks may have empty `payload` when the slate lives
        // inside the encrypted_meta region in encrypted mode — we don't
        // assert non-empty.)
        assert_eq!(parsed.version, SlatepackVersion::V1_0);
        assert!(matches!(
            parsed.mode,
            SlatepackMode::Plain | SlatepackMode::Encrypted
        ));
    }

    #[test]
    fn slatepack_bin_real_grin_wallet_fixture_round_trips() {
        // Parse → re-emit → parse again, confirm we don't lose info on the
        // path through our types.
        let bin_bytes = dearmor(FIXTURE).expect("fixture dearmor");
        let parsed_a = SlatepackBin::from_bytes(&bin_bytes).expect("first parse");
        let re_emitted = parsed_a.to_bytes();
        let parsed_b = SlatepackBin::from_bytes(&re_emitted).expect("second parse");
        assert_eq!(parsed_a, parsed_b, "SlatepackBin round-trip must be lossless");
    }

    #[test]
    fn end_to_end_armor_plus_bin_round_trip() {
        // Build a SlatepackBin, serialize, armor, dearmor, deserialize, check.
        let inner = b"end-to-end test payload that's longer than 16 bytes".to_vec();
        let sender = "grin1a9q4mvh8vn8gyfkfg67nrn0k4ampj9u8z99w5k5p20n0a2vkanms9ccr7x".to_string();

        let original = SlatepackBin::plain(inner.clone(), Some(sender.clone()));
        let bin_bytes = original.to_bytes();
        let armored = armor(&bin_bytes);

        // Now go the other way: armored string → bin bytes → SlatepackBin
        let dearmored_bytes = dearmor(&armored).expect("dearmor");
        let recovered = SlatepackBin::from_bytes(&dearmored_bytes).expect("parse");

        assert_eq!(recovered, original);
        assert_eq!(recovered.payload, inner);
        assert_eq!(recovered.sender.as_deref(), Some(sender.as_str()));
    }
}
