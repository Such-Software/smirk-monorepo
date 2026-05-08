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
}
