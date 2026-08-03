//! BIP32 / BIP39 derivation for BTC and LTC.
//!
//! Wraps rust-bitcoin's [`bitcoin::bip32`] with our [`Network`] type so
//! callers don't have to wire up `bitcoin::Network` themselves. We keep
//! this layer thin: the heavy lifting (HMAC-SHA512, secp256k1 child key
//! derivation, version-byte serialization) lives in rust-bitcoin and is
//! audited.

use bip39::Mnemonic;
use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::secp256k1::Secp256k1;

use crate::network::Network;

#[derive(Debug)]
pub enum Bip32Error {
    InvalidMnemonic,
    InvalidPath,
    DerivationFailed,
}

impl core::fmt::Display for Bip32Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Bip32Error::InvalidMnemonic => write!(f, "invalid BIP39 mnemonic"),
            Bip32Error::InvalidPath => write!(f, "invalid BIP32 derivation path"),
            Bip32Error::DerivationFailed => write!(f, "BIP32 child derivation failed"),
        }
    }
}

impl std::error::Error for Bip32Error {}

/// Convert a BIP39 mnemonic + optional passphrase into a master extended
/// private key for the given network. The xprv version bytes match
/// `network` so the `xprv1...` / `tprv...` / `Ltpv...` serialization is
/// correct for the chain.
pub fn mnemonic_to_xpriv(
    mnemonic_phrase: &str,
    passphrase: &str,
    network: Network,
) -> Result<Xpriv, Bip32Error> {
    let mnemonic = Mnemonic::parse_normalized(mnemonic_phrase)
        .map_err(|_| Bip32Error::InvalidMnemonic)?;
    let seed = mnemonic.to_seed(passphrase);
    Xpriv::new_master(network.as_bitcoin_network(), &seed)
        .map_err(|_| Bip32Error::DerivationFailed)
}

/// Derive a child xprv along a BIP32 path (e.g. `"m/84'/0'/0'/0/0"`).
pub fn derive_xpriv(master: &Xpriv, path: &str) -> Result<Xpriv, Bip32Error> {
    let secp = Secp256k1::new();
    let derivation: DerivationPath = path.parse().map_err(|_| Bip32Error::InvalidPath)?;
    master
        .derive_priv(&secp, &derivation)
        .map_err(|_| Bip32Error::DerivationFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    // BIP39 test vector: "abandon abandon abandon abandon abandon abandon
    // abandon abandon abandon abandon abandon about": the canonical
    // all-abandon mnemonic.
    const ABANDON_MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn abandon_mnemonic_master_xprv_btc_mainnet() {
        // BIP39 reference vector (Trezor python-mnemonic vectors.json),
        // 12-word all-abandon mnemonic with empty passphrase:
        let xprv = mnemonic_to_xpriv(ABANDON_MNEMONIC, "", Network::BtcMainnet)
            .expect("master derivation");
        assert_eq!(
            xprv.to_string(),
            "xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu"
        );
    }

    #[test]
    fn derive_bip84_first_account() {
        let master = mnemonic_to_xpriv(ABANDON_MNEMONIC, "", Network::BtcMainnet).unwrap();
        let child = derive_xpriv(&master, "m/84'/0'/0'/0/0").unwrap();
        // Sanity: derivation produces a child distinct from the master.
        assert_ne!(child.to_string(), master.to_string());
    }

    #[test]
    fn invalid_mnemonic_errors() {
        let err = mnemonic_to_xpriv("not a mnemonic", "", Network::BtcMainnet).unwrap_err();
        assert!(matches!(err, Bip32Error::InvalidMnemonic));
    }

    #[test]
    fn invalid_path_errors() {
        let master = mnemonic_to_xpriv(ABANDON_MNEMONIC, "", Network::BtcMainnet).unwrap();
        let err = derive_xpriv(&master, "not/a/path").unwrap_err();
        assert!(matches!(err, Bip32Error::InvalidPath));
    }
}
