//! Slatepack mode=1 (age-encrypted) payload encrypt/decrypt.
//!
//! Reference: `grin-wallet/libwallet/src/slatepack/types.rs::try_encrypt_payload`
//! / `try_decrypt_payload`.
//!
//! Slatepack mode=1 wraps a payload with [age](https://age-encryption.org/)
//! using the recipient's slatepack address (an ed25519 public key)
//! converted to its X25519 counterpart. The same conversion produces an
//! X25519 secret from the recipient's ed25519 spend key, used to decrypt.
//!
//! The encrypted bytes are not just the raw payload; they're a small
//! header + payload structure:
//!
//! ```text
//!   meta_len: u32 BE   (length of the metadata block that follows)
//!   metadata: ...      (sender + recipients list, see SlatepackEncMetadata)
//!   payload : ...      (the actual inner slate)
//! ```
//!
//! For now we always emit an **empty metadata block** (length 2, opt_flags
//! 0: the bytes `00 00 00 02 00 00`). This is compatible with `grin-wallet`'s
//! decoder, which sees zero senders + zero recipients and then the payload.
//! Populating the metadata with sender/recipient info is a follow-up.

use age::x25519::{Identity as AgeIdentity, Recipient as AgeRecipient};
use bech32::{ToBase32, Variant};
use curve25519_dalek::edwards::CompressedEdwardsY;
use sha2::{Digest, Sha512};
use std::io::{Read, Write};
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret as XSecret};

use crate::slatepack::SlatepackBin;
use crate::slatepack::SlatepackMode;
use crate::slatepack::SlatepackVersion;

/// Empty metadata block: `meta_len: u32 BE = 2 || opt_flags: u16 BE = 0`.
const EMPTY_META: [u8; 6] = [0, 0, 0, 2, 0, 0];

/// Convert a 32-byte ed25519 public key (the raw bytes inside a slatepack
/// address) to its X25519 counterpart, then bech32-encode for `age`.
///
/// Returns a string like `age1...` that `age::x25519::Recipient::from_str`
/// accepts.
pub fn ed25519_pub_to_age_recipient(ed25519_pub: &[u8; 32]) -> Result<String, String> {
    let cep = CompressedEdwardsY::from_slice(ed25519_pub)
        .map_err(|e| format!("invalid ed25519 pubkey: {e}"))?;
    let ep = cep
        .decompress()
        .ok_or_else(|| "ed25519 pubkey doesn't decompress to a curve point".to_string())?;
    let mp = ep.to_montgomery();
    let x_pub = XPublicKey::from(mp.to_bytes());
    bech32::encode("age", x_pub.as_bytes().to_base32(), Variant::Bech32)
        .map_err(|e| format!("bech32 encode: {e}"))
}

/// Convert a 32-byte ed25519 secret seed to an `age::x25519::Identity`
/// usable for decryption.
///
/// Matches grin-wallet: SHA-512(seed) → first 32 bytes → X25519 static
/// secret → bech32-encode with prefix `age-secret-key-`.
pub fn ed25519_secret_to_age_identity(ed25519_secret: &[u8; 32]) -> Result<AgeIdentity, String> {
    let mut hasher = Sha512::new();
    hasher.update(ed25519_secret);
    let hashed = hasher.finalize();
    let mut x_secret_bytes = [0u8; 32];
    x_secret_bytes.copy_from_slice(&hashed[0..32]);
    let x_secret = XSecret::from(x_secret_bytes);
    let bech_secret = bech32::encode(
        "age-secret-key-",
        x_secret.to_bytes().to_base32(),
        Variant::Bech32,
    )
    .map_err(|e| format!("bech32 encode: {e}"))?;
    // age expects the bech32 in uppercase for secret keys.
    bech_secret
        .to_uppercase()
        .parse::<AgeIdentity>()
        .map_err(|e| format!("parse age identity: {e}"))
}

/// Encrypt arbitrary bytes to a raw ed25519 public key, with NO slatepack
/// framing.
///
/// Same `age` construction as [`encrypt_to_recipient`], minus the slatepack
/// metadata block. That block belongs to Grin's wire format; a payload for a
/// different chain should not carry six bytes of another protocol's header, and
/// a reader of those bytes should not have to know Grin exists to strip them.
///
/// The public key must be a STANDARD ed25519 key, i.e. formed as
/// `G * clamp(SHA512(seed))`. A raw reduced scalar's public key (a Monero spend
/// key, say) will encrypt without complaint here and then fail to decrypt,
/// because [`age_open`] reconstructs the X25519 secret as `SHA512(seed)[0..32]`
/// and the two only agree for a standard keypair.
pub fn age_seal(payload: &[u8], recipient_ed25519_pub: &[u8; 32]) -> Result<Vec<u8>, String> {
    let recipient_str = ed25519_pub_to_age_recipient(recipient_ed25519_pub)?;
    let recipient: AgeRecipient = recipient_str
        .parse()
        .map_err(|e| format!("parse age recipient: {e}"))?;
    let encryptor = age::Encryptor::with_recipients(vec![Box::new(recipient)])
        .ok_or_else(|| "no age recipients".to_string())?;

    let mut out = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut out)
        .map_err(|e| format!("age wrap_output: {e}"))?;
    writer
        .write_all(payload)
        .map_err(|e| format!("age write: {e}"))?;
    writer.finish().map_err(|e| format!("age finish: {e}"))?;
    Ok(out)
}

/// Inverse of [`age_seal`]. `ed25519_secret` is the 32-byte ed25519 SEED.
pub fn age_open(ciphertext: &[u8], ed25519_secret: &[u8; 32]) -> Result<Vec<u8>, String> {
    let identity = ed25519_secret_to_age_identity(ed25519_secret)?;
    let decryptor =
        match age::Decryptor::new(ciphertext).map_err(|e| format!("age decryptor: {e}"))? {
            age::Decryptor::Recipients(d) => d,
            age::Decryptor::Passphrase(_) => {
                return Err("age payload is passphrase-encrypted, not recipient-encrypted".into())
            }
        };
    let mut reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|e| format!("age decrypt: {e}"))?;
    let mut out = Vec::new();
    reader
        .read_to_end(&mut out)
        .map_err(|e| format!("age read: {e}"))?;
    Ok(out)
}

/// Encrypt a payload to a single recipient's slatepack address (the raw
/// 32-byte ed25519 public key inside the bech32 address).
///
/// Returns the bytes that go into `SlatepackBin.payload` when `mode = 1`.
pub fn encrypt_to_recipient(
    payload: &[u8],
    recipient_ed25519_pub: &[u8; 32],
) -> Result<Vec<u8>, String> {
    let recipient_str = ed25519_pub_to_age_recipient(recipient_ed25519_pub)?;
    let recipient: AgeRecipient = recipient_str
        .parse()
        .map_err(|e| format!("parse age recipient: {e}"))?;

    // Build the inner plaintext: [empty meta block] || payload.
    let mut to_encrypt = Vec::with_capacity(EMPTY_META.len() + payload.len());
    to_encrypt.extend_from_slice(&EMPTY_META);
    to_encrypt.extend_from_slice(payload);

    let encryptor =
        age::Encryptor::with_recipients(
            vec![Box::new(recipient) as Box<dyn age::Recipient + Send>],
        )
        .ok_or_else(|| "no recipients (impossible: we just constructed one)".to_string())?;
    let mut encrypted = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut encrypted)
        .map_err(|e| format!("age wrap_output: {e}"))?;
    writer
        .write_all(&to_encrypt)
        .map_err(|e| format!("age write_all: {e}"))?;
    writer.finish().map_err(|e| format!("age finish: {e}"))?;

    Ok(encrypted)
}

/// Decrypt an age-encrypted payload using the recipient's 32-byte ed25519
/// secret seed.
///
/// Returns just the inner payload bytes; the metadata header is stripped.
pub fn decrypt_with_secret(
    encrypted_payload: &[u8],
    ed25519_secret: &[u8; 32],
) -> Result<Vec<u8>, String> {
    let identity = ed25519_secret_to_age_identity(ed25519_secret)?;

    let decryptor =
        age::Decryptor::new(encrypted_payload).map_err(|e| format!("age::Decryptor::new: {e}"))?;
    let recipients_decryptor = match decryptor {
        age::Decryptor::Recipients(d) => d,
        age::Decryptor::Passphrase(_) => {
            return Err("expected recipients-mode age stream, got passphrase mode".to_string())
        }
    };

    let mut decrypted = Vec::new();
    let mut reader = recipients_decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|e| format!("age decrypt: {e}"))?;
    reader
        .read_to_end(&mut decrypted)
        .map_err(|e| format!("age read_to_end: {e}"))?;

    // Strip the metadata block.
    if decrypted.len() < 4 {
        return Err(format!(
            "decrypted payload too short ({} bytes)",
            decrypted.len()
        ));
    }
    let mut meta_len_bytes = [0u8; 4];
    meta_len_bytes.copy_from_slice(&decrypted[0..4]);
    let meta_len = u32::from_be_bytes(meta_len_bytes) as usize;
    if decrypted.len() < 4 + meta_len {
        return Err(format!(
            "metadata length {meta_len} exceeds decrypted payload size ({})",
            decrypted.len()
        ));
    }
    Ok(decrypted[4 + meta_len..].to_vec())
}

/// Build a complete encrypted-mode SlatepackBin from a payload + recipient.
pub fn pack_encrypted(
    payload: &[u8],
    sender: Option<String>,
    recipient_ed25519_pub: &[u8; 32],
) -> Result<SlatepackBin, String> {
    let encrypted_payload = encrypt_to_recipient(payload, recipient_ed25519_pub)?;
    Ok(SlatepackBin {
        version: SlatepackVersion::V1_0,
        mode: SlatepackMode::Encrypted,
        sender,
        payload: encrypted_payload,
    })
}

/// Decrypt a SlatepackBin's payload using the recipient's ed25519 secret
/// seed. Returns the inner cleartext payload bytes.
///
/// Errors if `bin.mode` is not `Encrypted`.
pub fn unpack_encrypted(bin: &SlatepackBin, ed25519_secret: &[u8; 32]) -> Result<Vec<u8>, String> {
    match bin.mode {
        SlatepackMode::Encrypted => decrypt_with_secret(&bin.payload, ed25519_secret),
        SlatepackMode::Plain => {
            Err("slatepack is plaintext-mode; no decryption needed".to_string())
        }
    }
}

#[cfg(test)]
mod generic_age_tests {
    use super::*;

    /// A standard ed25519 keypair, the only kind `age_seal` accepts.
    fn keypair(seed_byte: u8) -> ([u8; 32], [u8; 32]) {
        use ed25519_dalek::SigningKey;
        let seed = [seed_byte; 32];
        let sk = SigningKey::from_bytes(&seed);
        (seed, sk.verifying_key().to_bytes())
    }

    #[test]
    fn seals_and_opens_an_arbitrary_payload() {
        let (seed, pubkey) = keypair(7);
        for len in [0usize, 1, 32, 1024] {
            let payload = vec![0xABu8; len];
            let ct = age_seal(&payload, &pubkey).expect("seal");
            assert_ne!(ct, payload, "ciphertext must not be the plaintext");
            assert_eq!(age_open(&ct, &seed).expect("open"), payload);
        }
    }

    /// The whole reason this exists next to `encrypt_to_recipient`: no six-byte
    /// slatepack metadata block on a payload that is not a slatepack.
    #[test]
    fn carries_no_slatepack_metadata() {
        let (seed, pubkey) = keypair(9);
        let payload = b"not a slate".to_vec();
        let plain = age_open(&age_seal(&payload, &pubkey).unwrap(), &seed).unwrap();
        assert_eq!(plain, payload);

        // The slatepack variant does prepend it, so the two are distinguishable.
        let slatepack =
            decrypt_with_secret(&encrypt_to_recipient(&payload, &pubkey).unwrap(), &seed).unwrap();
        assert_eq!(slatepack, payload, "slatepack path strips its own metadata");
    }

    #[test]
    fn the_wrong_secret_cannot_open_it() {
        let (_, pubkey) = keypair(1);
        let (other_seed, _) = keypair(2);
        let ct = age_seal(b"secret", &pubkey).unwrap();
        assert!(age_open(&ct, &other_seed).is_err());
    }

    #[test]
    fn a_corrupted_ciphertext_is_rejected_not_silently_truncated() {
        let (seed, pubkey) = keypair(3);
        let mut ct = age_seal(b"secret payload", &pubkey).unwrap();
        let last = ct.len() - 1;
        ct[last] ^= 0xFF;
        assert!(age_open(&ct, &seed).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Derive an (ed25519_secret_seed, ed25519_pubkey) keypair from arbitrary
    /// 32 bytes: used to fabricate test recipients. We use ed25519-dalek's
    /// SigningKey for the conversion, which matches Grin's convention.
    fn keypair_from_seed(seed: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
        use ed25519_dalek::SigningKey;
        let sk = SigningKey::from_bytes(seed);
        let pk = sk.verifying_key().to_bytes();
        (*seed, pk)
    }

    #[test]
    fn ed25519_to_age_recipient_format_is_age_bech32() {
        let (_sk, pk) = keypair_from_seed(&[7u8; 32]);
        let s = ed25519_pub_to_age_recipient(&pk).unwrap();
        assert!(s.starts_with("age1"), "got: {s}");
        // bech32 of 32 bytes = 4 ("age1") + 52 + 6 = 62 chars
        assert_eq!(s.len(), 62, "got: {s}");
    }

    #[test]
    fn encrypt_decrypt_round_trip_short_payload() {
        let (sk, pk) = keypair_from_seed(&[42u8; 32]);
        let payload = b"hello slatepack encryption".to_vec();

        let encrypted = encrypt_to_recipient(&payload, &pk).expect("encrypt");
        let decrypted = decrypt_with_secret(&encrypted, &sk).expect("decrypt");
        assert_eq!(decrypted, payload);
    }

    #[test]
    fn encrypt_decrypt_round_trip_binary_payload() {
        let (sk, pk) = keypair_from_seed(&[1u8; 32]);
        let payload: Vec<u8> = (0..=255).cycle().take(1024).collect();

        let encrypted = encrypt_to_recipient(&payload, &pk).expect("encrypt");
        let decrypted = decrypt_with_secret(&encrypted, &sk).expect("decrypt");
        assert_eq!(decrypted, payload);
    }

    #[test]
    fn decrypt_fails_with_wrong_secret() {
        let (_sk_a, pk_a) = keypair_from_seed(&[1u8; 32]);
        let (sk_b, _pk_b) = keypair_from_seed(&[2u8; 32]);

        let payload = b"this is for A".to_vec();
        let encrypted = encrypt_to_recipient(&payload, &pk_a).unwrap();
        // B's secret cannot decrypt content addressed to A.
        let result = decrypt_with_secret(&encrypted, &sk_b);
        assert!(result.is_err());
    }

    #[test]
    fn pack_unpack_round_trip() {
        let (sk, pk) = keypair_from_seed(&[99u8; 32]);
        let payload = b"end-to-end encrypted slatepack payload".to_vec();
        let sender =
            Some("grin1senderaddrxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".to_string());

        let bin = pack_encrypted(&payload, sender.clone(), &pk).expect("pack");
        assert_eq!(bin.mode, SlatepackMode::Encrypted);
        assert_eq!(bin.sender, sender);

        let recovered = unpack_encrypted(&bin, &sk).expect("unpack");
        assert_eq!(recovered, payload);
    }

    #[test]
    fn unpack_rejects_plaintext_slatepack() {
        let bin = SlatepackBin::plain(b"not encrypted".to_vec(), None);
        let result = unpack_encrypted(&bin, &[0u8; 32]);
        assert!(result.is_err());
    }
}
