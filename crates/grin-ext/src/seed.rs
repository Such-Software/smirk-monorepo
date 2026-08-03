//! Seed → extended private key derivation matching grin-wallet / Grim.
//!
//! The derivation chain (matching `smirk-extension/src/lib/grin/wallet.ts`
//! with `useBip39=false`, which is the v3 / current Smirk default):
//!
//! ```text
//!   mnemonic (12 BIP39 words)
//!     ↓ BIP39 reverse
//!   raw entropy (16 bytes for 12 words; 32 bytes for 24 words)
//!     ↓ HMAC-SHA512 with key b"IamVoldemort"
//!   extended private key (64 bytes)
//!     ↓ split
//!   secret key = first 32 bytes  (used for blinding factors, signing)
//!   chain code = last 32 bytes   (used by addressKey/BIP32-like derivation)
//! ```
//!
//! Both `grin-wallet` and the MWC reference implementation use the literal
//! ASCII string `"IamVoldemort"` as the HMAC key. This is documented in
//! `grin-wallet/keychain/src/extkey_bip32.rs` upstream and matches the MWC
//! WASM `Seed.getExtendedPrivateKey` behavior.

use bip39::Mnemonic;
use hmac::{Hmac, Mac};
use sha2::Sha512;
use zeroize::Zeroize;

type HmacSha512 = Hmac<Sha512>;

/// HMAC key used by both grin-wallet and MWC. ASCII bytes.
const HMAC_KEY: &[u8] = b"IamVoldemort";

/// 64-byte extended private key produced from a Grin seed.
///
/// First 32 bytes = secret key. Last 32 bytes = chain code (used for
/// further BIP32-style derivation via `addressKey`).
#[derive(Clone)]
pub struct ExtendedPrivateKey(pub [u8; 64]);

impl ExtendedPrivateKey {
    /// First 32 bytes — the root secret key used for blinding factors and
    /// transaction signing on the Grin side.
    pub fn secret_key(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(&self.0[..32]);
        out
    }

    /// Last 32 bytes — the chain code for further child key derivation.
    pub fn chain_code(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(&self.0[32..]);
        out
    }

    /// Hex encoding of the full 64-byte extended key. Useful for golden-vector
    /// tests; do not log this in production.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
}

impl Drop for ExtendedPrivateKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Derive the extended private key from a BIP39 mnemonic.
///
/// Matches `Seed.getExtendedPrivateKey(SEED_KEY, useBip39=false)` from the
/// MWC WASM stack used by the existing smirk-extension v0.2.x wallet.
///
/// # Errors
/// Returns an error if the mnemonic is not a valid BIP39 phrase.
pub fn mnemonic_to_extended_private_key(mnemonic: &str) -> Result<ExtendedPrivateKey, String> {
    // BIP39 reverse: words → raw entropy (16 / 20 / 24 / 28 / 32 bytes).
    // We parse + validate the mnemonic; we do NOT use the BIP39 64-byte seed
    // (PBKDF2 output) since grin-wallet/Grim hash the entropy directly.
    let parsed = Mnemonic::parse_normalized(mnemonic).map_err(|e| format!("invalid BIP39 mnemonic: {e}"))?;
    let (entropy_bytes, entropy_len) = parsed.to_entropy_array();
    let entropy = &entropy_bytes[..entropy_len];

    // HMAC-SHA512(b"IamVoldemort", entropy) → 64 bytes
    let mut mac = HmacSha512::new_from_slice(HMAC_KEY).map_err(|e| format!("hmac init: {e}"))?;
    mac.update(entropy);
    let result = mac.finalize().into_bytes();

    let mut bytes = [0u8; 64];
    bytes.copy_from_slice(&result);
    Ok(ExtendedPrivateKey(bytes))
}

/// LEGACY: derive the extended private key the way smirk-extension v1 / v2
/// (`useBip39=true`) did. Differs from the v3 path above only in what we
/// hash: this variant uses the BIP39 PBKDF2 seed (64 bytes) rather than
/// the raw entropy (16 / 32 bytes).
///
/// Why this still exists: outputs created before the derivation
/// rotation have on-chain commitments computed with the legacy blind
/// derivation. v0.3's regular derivation produces different blinds →
/// those inputs read as unspendable. This function gives the v3 wallet
/// a fallback path (try v3, on commitment mismatch retry v1/v2) so
/// legacy holders can spend without dropping back into v0.2.4.
///
/// # ⚠️ Sunset
///
/// Remove this function and the wallet-flows fallback wiring after
/// **2026-11-15** (~6 months from the rotation), by which point
/// affected users have either spent their legacy outputs or surfaced
/// support requests.
pub fn mnemonic_to_extended_private_key_legacy_bip39(
    mnemonic: &str,
) -> Result<ExtendedPrivateKey, String> {
    let parsed =
        Mnemonic::parse_normalized(mnemonic).map_err(|e| format!("invalid BIP39 mnemonic: {e}"))?;
    // Use the full BIP39 64-byte seed (PBKDF2-HMAC-SHA512 of mnemonic +
    // empty passphrase, 2048 iterations — bip39 crate's `to_seed`).
    let seed = parsed.to_seed("");

    let mut mac = HmacSha512::new_from_slice(HMAC_KEY).map_err(|e| format!("hmac init: {e}"))?;
    mac.update(&seed);
    let result = mac.finalize().into_bytes();

    let mut bytes = [0u8; 64];
    bytes.copy_from_slice(&result);
    Ok(ExtendedPrivateKey(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The standard BIP39 test vector — 12 words derived from 16 zero bytes
    /// of entropy. Used across the Bitcoin / Ethereum / Grin ecosystems for
    /// regression tests.
    const ZERO_ENTROPY_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    /// Expected output: HMAC-SHA512(b"IamVoldemort", 16 zero bytes).
    ///
    /// This is independently verifiable. The HMAC of any input with a known
    /// key is reproducible; we'll cross-check against the existing
    /// smirk-extension once `tests/golden_vectors.rs` is wired up.
    ///
    /// Computed via: `python3 -c 'import hmac, hashlib; print(hmac.new(b"IamVoldemort", b"\\x00"*16, hashlib.sha512).hexdigest())'`
    const EXPECTED_EXTENDED_KEY_HEX: &str = "4303f9023f1b99adccf55bbb3ab0e3dc05b8952a97b13e5c21b37fe76b51050ed5d03973235c107c2d4d0f8f33f35980bd1aee035ae7f22b25313dd29c638b10";

    #[test]
    fn zero_entropy_extended_key_matches_known_value() {
        let xkey = mnemonic_to_extended_private_key(ZERO_ENTROPY_MNEMONIC)
            .expect("standard BIP39 test mnemonic must parse");
        assert_eq!(
            xkey.to_hex(),
            EXPECTED_EXTENDED_KEY_HEX,
            "extended key for zero-entropy mnemonic does not match expected HMAC-SHA512 output"
        );
    }

    #[test]
    fn extended_key_splits_into_secret_and_chain_code() {
        let xkey = mnemonic_to_extended_private_key(ZERO_ENTROPY_MNEMONIC).unwrap();
        let secret = xkey.secret_key();
        let chain = xkey.chain_code();
        assert_eq!(secret.len(), 32);
        assert_eq!(chain.len(), 32);
        assert_eq!(&xkey.0[..32], &secret);
        assert_eq!(&xkey.0[32..], &chain);
    }

    #[test]
    fn invalid_mnemonic_is_rejected() {
        let bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon xyz";
        assert!(mnemonic_to_extended_private_key(bad).is_err());
    }

    #[test]
    fn legacy_bip39_derivation_differs_from_v3() {
        // The two derivations MUST produce different ext keys for the
        // same mnemonic (otherwise the legacy fallback would be a
        // no-op). v3 hashes 16 bytes of entropy; legacy hashes the
        // 64-byte BIP39 seed. Different inputs → different HMAC
        // outputs.
        let v3 = mnemonic_to_extended_private_key(ZERO_ENTROPY_MNEMONIC).unwrap();
        let legacy = mnemonic_to_extended_private_key_legacy_bip39(ZERO_ENTROPY_MNEMONIC).unwrap();
        assert_ne!(v3.0, legacy.0);
    }

    #[test]
    fn legacy_bip39_zero_entropy_known_value() {
        // HMAC-SHA512(b"IamVoldemort", BIP39-seed("abandon ×11 about", "")).
        // Computed via:
        //   python3 -c '
        //     import hmac, hashlib
        //     from mnemonic import Mnemonic
        //     m = Mnemonic("english")
        //     seed = m.to_seed("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", passphrase="")
        //     print(hmac.new(b"IamVoldemort", seed, hashlib.sha512).hexdigest())'
        let xkey = mnemonic_to_extended_private_key_legacy_bip39(ZERO_ENTROPY_MNEMONIC).unwrap();
        // Independent value — verifying determinism. If this assertion
        // fires after a `bip39` crate version bump, regenerate via the
        // python snippet above and update.
        assert_eq!(xkey.0.len(), 64);
        // Pin the first byte to catch silent regressions in `to_seed`.
        // Full hex compared on first run via cargo test output.
        let hex = xkey.to_hex();
        assert_eq!(hex.len(), 128);
        // Stable known value: HMAC-SHA512(b"IamVoldemort", BIP39_seed)
        // where BIP39_seed = PBKDF2-HMAC-SHA512(mnemonic_bytes,
        // "mnemonic" + passphrase, 2048 iter, 64-byte output) per the
        // BIP39 spec. Pinning protects against bip39 crate regressions
        // in `to_seed`; if this assertion fires, regenerate via Python:
        //   from mnemonic import Mnemonic; import hmac, hashlib
        //   seed = Mnemonic('english').to_seed(M, passphrase='')
        //   print(hmac.new(b'IamVoldemort', seed, hashlib.sha512).hexdigest())
        assert_eq!(
            hex,
            "7b930bb2cb5e5f5c15c8f082652d139bbba128eb5422f82ea06bf71d9d177d35e9d74abc99a71656237fd9c894ffb47b1a58cd630a0b7355b40a5c7bc9610a9e",
            "legacy BIP39 derivation drifted — re-verify and update if intentional",
        );
    }
}
