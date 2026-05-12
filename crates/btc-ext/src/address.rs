//! Address derivation for BTC and LTC.
//!
//! Two flavors implemented in v1:
//! - **P2WPKH** (BIP84) — native segwit, `bc1q…` / `ltc1q…`.
//! - **P2TR** (BIP86) — taproot, `bc1p…` / `ltc1p…`. Uses BIP341
//!   key-only spend with no script tree.
//!
//! Legacy P2PKH and P2SH-P2WPKH are intentionally omitted from v1 — modern
//! wallets don't generate them, and clients that receive to legacy
//! addresses can still spend them through PSBT.
//!
//! For LTC we encode bech32/bech32m manually with the `bech32` crate
//! because rust-bitcoin's `bitcoin::address::Address` uses BTC HRPs only.
//! The cryptographic prep (HASH160, BIP341 taproot tweak) is the same for
//! both chains, so we reuse rust-bitcoin for those steps.

use bech32::{segwit, Fe32, Hrp};
use bitcoin::bip32::Xpriv;
use bitcoin::hashes::{hash160, Hash};
use bitcoin::key::TapTweak;
use bitcoin::secp256k1::Secp256k1;
use bitcoin::PublicKey;

use crate::network::Network;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AddressKind {
    /// Native segwit (BIP84). bech32, witness version 0.
    P2wpkh,
    /// Taproot (BIP86). bech32m, witness version 1, key-only spend.
    P2tr,
}

#[derive(Debug)]
pub enum AddressError {
    Bech32Encode,
    Bech32Decode,
    BadHrp,
    UnsupportedWitness,
}

impl core::fmt::Display for AddressError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            AddressError::Bech32Encode => write!(f, "bech32 encoding failed"),
            AddressError::Bech32Decode => write!(f, "bech32 decoding failed"),
            AddressError::BadHrp => write!(f, "invalid bech32 HRP for network"),
            AddressError::UnsupportedWitness => {
                write!(f, "unsupported witness version / program length")
            }
        }
    }
}

impl std::error::Error for AddressError {}

/// Decode a bech32(/bech32m) recipient address into the script_pubkey
/// rust-bitcoin needs to build a transaction output. Supports P2WPKH
/// (witness v0, 20-byte program) and P2TR (witness v1, 32-byte program).
///
/// Works for BTC and LTC. Network mismatches (e.g. mainnet `bc1` parsed
/// under LtcMainnet) return [`AddressError::BadHrp`]. Witness versions
/// or program lengths we don't yet support (P2WSH, future witness
/// versions) return [`AddressError::UnsupportedWitness`].
///
/// We can't use rust-bitcoin's `Address::from_str` directly here because
/// it only knows BTC HRPs (`bc`/`tb`); LTC's `ltc`/`tltc` HRPs would
/// silently fail to parse. Doing our own bech32 decode + ScriptBuf
/// construction handles both chains uniformly.
pub fn decode_recipient_script(
    addr: &str,
    network: Network,
) -> Result<bitcoin::ScriptBuf, AddressError> {
    let (hrp, version, program) =
        bech32::segwit::decode(addr).map_err(|_| AddressError::Bech32Decode)?;
    if hrp.as_str() != network.bech32_hrp() {
        return Err(AddressError::BadHrp);
    }
    match (version.to_u8(), program.len()) {
        (0, 20) => {
            let arr: [u8; 20] = program
                .as_slice()
                .try_into()
                .map_err(|_| AddressError::Bech32Decode)?;
            let wpkh = bitcoin::WPubkeyHash::from_byte_array(arr);
            Ok(bitcoin::ScriptBuf::new_p2wpkh(&wpkh))
        }
        (1, 32) => {
            let arr: [u8; 32] = program
                .as_slice()
                .try_into()
                .map_err(|_| AddressError::Bech32Decode)?;
            let xonly = bitcoin::secp256k1::XOnlyPublicKey::from_slice(&arr)
                .map_err(|_| AddressError::Bech32Decode)?;
            // The address ENCODES the post-tweak output key directly
            // (BIP341 key-only spend). We're constructing the
            // script_pubkey for a recipient — we never need to spend
            // from it, so wrapping the x-only as "already tweaked" is
            // exactly right here.
            let tweaked = bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(xonly);
            Ok(bitcoin::ScriptBuf::new_p2tr_tweaked(tweaked))
        }
        _ => Err(AddressError::UnsupportedWitness),
    }
}

/// Derive an address from a child xprv. The xprv is expected to be already
/// at the leaf path (e.g. `m/84'/0'/0'/0/0` for BIP84 receive index 0); we
/// don't apply further derivation here.
pub fn derive_address(
    xprv: &Xpriv,
    kind: AddressKind,
    network: Network,
) -> Result<String, AddressError> {
    let secp = Secp256k1::new();
    let pubkey = PublicKey::new(xprv.private_key.public_key(&secp));

    let hrp = Hrp::parse(network.bech32_hrp()).map_err(|_| AddressError::BadHrp)?;

    match kind {
        AddressKind::P2wpkh => {
            // BIP141: witness program is HASH160(compressed_pubkey).
            let pk_bytes = pubkey.inner.serialize();
            let hash = hash160::Hash::hash(&pk_bytes);
            // Witness version 0 → bech32 (not bech32m).
            segwit::encode(hrp, Fe32::Q, hash.as_byte_array())
                .map_err(|_| AddressError::Bech32Encode)
        }
        AddressKind::P2tr => {
            // BIP341 key-only spend: tweak the internal pubkey with
            // tagged_hash("TapTweak", x_only_pubkey).
            let (xonly, _parity) = pubkey.inner.x_only_public_key();
            let (tweaked, _parity) = xonly.tap_tweak(&secp, None);
            let program = tweaked.to_x_only_public_key().serialize();
            // Witness version 1 → bech32m.
            segwit::encode(hrp, Fe32::P, &program).map_err(|_| AddressError::Bech32Encode)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bip32::{derive_xpriv, mnemonic_to_xpriv};

    const ABANDON_MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn bip84_first_address_btc_mainnet() {
        // BIP84 reference vector (from the BIP itself):
        //   m/84'/0'/0'/0/0 → bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu
        let master = mnemonic_to_xpriv(ABANDON_MNEMONIC, "", Network::BtcMainnet).unwrap();
        let child = derive_xpriv(&master, "m/84'/0'/0'/0/0").unwrap();
        let addr = derive_address(&child, AddressKind::P2wpkh, Network::BtcMainnet).unwrap();
        assert_eq!(addr, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    }

    #[test]
    fn bip86_first_address_btc_mainnet() {
        // BIP86 reference vector (from the BIP itself):
        //   m/86'/0'/0'/0/0 → bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr
        let master = mnemonic_to_xpriv(ABANDON_MNEMONIC, "", Network::BtcMainnet).unwrap();
        let child = derive_xpriv(&master, "m/86'/0'/0'/0/0").unwrap();
        let addr = derive_address(&child, AddressKind::P2tr, Network::BtcMainnet).unwrap();
        assert_eq!(
            addr,
            "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"
        );
    }

    #[test]
    fn ltc_p2wpkh_uses_ltc_hrp() {
        let master = mnemonic_to_xpriv(ABANDON_MNEMONIC, "", Network::LtcMainnet).unwrap();
        let child = derive_xpriv(&master, "m/84'/2'/0'/0/0").unwrap();
        let addr = derive_address(&child, AddressKind::P2wpkh, Network::LtcMainnet).unwrap();
        assert!(addr.starts_with("ltc1q"), "got {addr}");
    }

    #[test]
    fn testnet_p2wpkh_uses_tb_hrp() {
        let master = mnemonic_to_xpriv(ABANDON_MNEMONIC, "", Network::BtcTestnet).unwrap();
        let child = derive_xpriv(&master, "m/84'/1'/0'/0/0").unwrap();
        let addr = derive_address(&child, AddressKind::P2wpkh, Network::BtcTestnet).unwrap();
        assert!(addr.starts_with("tb1q"), "got {addr}");
    }
}
