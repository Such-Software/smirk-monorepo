//! Slatepack address derivation, matching `grin-wallet` / Grim.
//!
//! Reference: `grin-wallet/libwallet/src/address.rs::address_from_derivation_path`.
//!
//! The chain (for the default account `m/0`, address index 0):
//!
//! ```text
//!   extended_private_key  (64 bytes from seed::mnemonic_to_extended_private_key)
//!     ↓ BIP32 child key derivation, path m/0/1/0, non-hardened, no blind switch
//!   secret_key  (32 bytes)
//!     ↓ blake2b(32, key=&[], data=secret_key)
//!   hashed  (32 bytes)
//!     ↓ used as ed25519 secret key bytes
//!   ed25519_keypair
//!     ↓ public key (32 bytes)
//!     ↓ bech32 encode with HRP "grin" (mainnet) or "tgrin" (testnet)
//!   slatepack address  (e.g. "grin1abc...")
//! ```
//!
//! Index 0 is the default ("primary") slatepack address. Higher indices give
//! additional addresses derivable from the same wallet, used by
//! `grin-wallet`'s payment-proof derivation index, among other things.

use bech32::{FromBase32, ToBase32, Variant};
use blake2::{
    digest::{Update, VariableOutput},
    Blake2bVar,
};
use ed25519_dalek::{SigningKey, VerifyingKey};

use crate::bip32::derive_path;

/// HRP used by Grin mainnet slatepack addresses.
pub const HRP_MAINNET: &str = "grin";

/// HRP used by Grin testnet slatepack addresses.
pub const HRP_TESTNET: &str = "tgrin";

/// Network selector for slatepack address encoding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Network {
    Mainnet,
    Testnet,
}

impl Network {
    fn hrp(self) -> &'static str {
        match self {
            Network::Mainnet => HRP_MAINNET,
            Network::Testnet => HRP_TESTNET,
        }
    }
}

/// Derive the receiver's slatepack-address ed25519 secret seed for the
/// given mnemonic and index. This is the value that pairs with the
/// public address `slatepack_address` returns, and the key used to sign
/// payment proofs.
///
/// Production wallets should be careful with this output: it's a
/// long-lived secret. Treat it like the user's seed.
pub fn slatepack_address_ed25519_secret(
    mnemonic: &str,
    index: u32,
) -> Result<[u8; 32], String> {
    // Same chain as `slatepack_address`, just stops at the ed25519 secret
    // instead of going on to bech32-encode the public key.
    let xkey = crate::seed::mnemonic_to_extended_private_key(mnemonic)?;
    let path = [0u32, 1u32, index];
    let secret_key = crate::bip32::derive_path(&xkey.0, &path)?;

    let mut hasher = Blake2bVar::new(32).map_err(|e| format!("blake2b init: {e}"))?;
    hasher.update(&secret_key);
    let mut hashed = [0u8; 32];
    hasher
        .finalize_variable(&mut hashed)
        .map_err(|e| format!("blake2b finalize: {e}"))?;
    Ok(hashed)
}

/// Derive the slatepack address for the given mnemonic and index, on the
/// given network.
///
/// Index 0 is the wallet's default ("primary") slatepack address, the one
/// `grin-wallet` shows by default. Index N produces the Nth additional
/// address.
pub fn slatepack_address(
    mnemonic: &str,
    index: u32,
    network: Network,
) -> Result<String, String> {
    // 1. Mnemonic → extended private key (HMAC-SHA512 with "IamVoldemort").
    let xkey = crate::seed::mnemonic_to_extended_private_key(mnemonic)?;

    // 2. BIP32 child key at path m/0/1/<index>. Grin's
    //    `address_from_derivation_path` always sets the parent depth-1 path
    //    to 1 ("address generation path"), then appends the index.
    let path = [0u32, 1u32, index];
    let secret_key = derive_path(&xkey.0, &path)?;

    // 3. BLAKE2b(32, no key, secret_key) → hashed bytes.
    let mut hasher = Blake2bVar::new(32).map_err(|e| format!("blake2b init: {e}"))?;
    hasher.update(&secret_key);
    let mut hashed = [0u8; 32];
    hasher
        .finalize_variable(&mut hashed)
        .map_err(|e| format!("blake2b finalize: {e}"))?;

    // 4. ed25519 keypair from those 32 bytes; take the public key.
    let signing_key = SigningKey::from_bytes(&hashed);
    let verifying_key: VerifyingKey = signing_key.verifying_key();
    let pub_bytes = verifying_key.to_bytes();

    // 5. Bech32 encode with the right HRP.
    let encoded = bech32::encode(network.hrp(), pub_bytes.to_base32(), Variant::Bech32)
        .map_err(|e| format!("bech32 encode: {e}"))?;

    Ok(encoded)
}

/// Decode a bech32 slatepack address back to its underlying 32-byte
/// ed25519 public key bytes. Inverse of [`slatepack_address`].
///
/// Accepts either mainnet (`grin1…`) or testnet (`tgrin1…`) HRPs.
/// Returns the network alongside the pubkey so callers can warn on
/// HRP mismatch when sending.
pub fn slatepack_address_to_pubkey(addr: &str) -> Result<([u8; 32], Network), String> {
    let (hrp, data, variant) =
        bech32::decode(addr).map_err(|e| format!("bech32 decode: {e}"))?;
    if variant != Variant::Bech32 {
        return Err(format!(
            "slatepack address uses bech32 variant, got {variant:?}"
        ));
    }
    let network = match hrp.as_str() {
        HRP_MAINNET => Network::Mainnet,
        HRP_TESTNET => Network::Testnet,
        other => return Err(format!("unexpected HRP '{other}', expected 'grin' or 'tgrin'")),
    };
    let bytes = Vec::<u8>::from_base32(&data).map_err(|e| format!("base32 decode: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "decoded pubkey length {} != 32",
            bytes.len()
        ));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok((out, network))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZERO_ENTROPY_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn zero_entropy_mainnet_address_has_correct_format() {
        let addr = slatepack_address(ZERO_ENTROPY_MNEMONIC, 0, Network::Mainnet)
            .expect("derivation succeeds for standard test mnemonic");
        // Mainnet addresses always start with "grin1" (HRP + bech32 separator).
        assert!(addr.starts_with("grin1"), "expected grin1 prefix, got: {addr}");
        // ed25519 pubkey (32 bytes) = 52 bech32 chars + 6 checksum chars.
        // Plus "grin1" prefix = 4 + 1 + 52 + 6 = 63 chars.
        assert_eq!(addr.len(), 63, "expected 63-char address, got {} chars: {}", addr.len(), addr);
    }

    #[test]
    fn zero_entropy_testnet_uses_tgrin_prefix() {
        let addr = slatepack_address(ZERO_ENTROPY_MNEMONIC, 0, Network::Testnet)
            .expect("derivation succeeds for standard test mnemonic");
        assert!(addr.starts_with("tgrin1"), "expected tgrin1 prefix, got: {addr}");
    }

    #[test]
    fn different_indices_produce_different_addresses() {
        let addr0 = slatepack_address(ZERO_ENTROPY_MNEMONIC, 0, Network::Mainnet).unwrap();
        let addr1 = slatepack_address(ZERO_ENTROPY_MNEMONIC, 1, Network::Mainnet).unwrap();
        assert_ne!(addr0, addr1);
    }

    #[test]
    fn slatepack_address_decode_round_trip_mainnet() {
        let addr = slatepack_address(ZERO_ENTROPY_MNEMONIC, 0, Network::Mainnet).unwrap();
        let (pubkey, network) = slatepack_address_to_pubkey(&addr).expect("decode succeeds");
        assert_eq!(network, Network::Mainnet);
        assert_eq!(pubkey.len(), 32);
        // Re-encode and verify match.
        let re_encoded =
            bech32::encode(network.hrp(), pubkey.to_base32(), Variant::Bech32).unwrap();
        assert_eq!(re_encoded, addr);
    }

    #[test]
    fn slatepack_address_decode_round_trip_testnet() {
        let addr = slatepack_address(ZERO_ENTROPY_MNEMONIC, 0, Network::Testnet).unwrap();
        let (_, network) = slatepack_address_to_pubkey(&addr).unwrap();
        assert_eq!(network, Network::Testnet);
    }

    #[test]
    fn slatepack_address_decode_rejects_wrong_hrp() {
        // A bech32 string with a non-grin HRP.
        assert!(slatepack_address_to_pubkey("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").is_err());
    }

    #[test]
    fn derivation_is_deterministic() {
        let addr_a = slatepack_address(ZERO_ENTROPY_MNEMONIC, 0, Network::Mainnet).unwrap();
        let addr_b = slatepack_address(ZERO_ENTROPY_MNEMONIC, 0, Network::Mainnet).unwrap();
        assert_eq!(addr_a, addr_b);
    }
}

#[cfg(test)]
mod print_test {
    use super::*;
    /// Run with: cargo test -p grin-ext print_zero_entropy_addr -- --nocapture
    /// Useful for cross-checking against grin-wallet output.
    #[test]
    fn print_zero_entropy_addr() {
        let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        for i in 0..3 {
            let addr = slatepack_address(mnemonic, i, Network::Mainnet).unwrap();
            println!("idx {i} (mainnet): {addr}");
        }
    }
}
