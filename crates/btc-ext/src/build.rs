//! Build unsigned PSBTs for BTC/LTC sends.
//!
//! v1 scope: single-recipient send with optional change output, P2WPKH
//! (BIP84) inputs and outputs. The caller supplies (a) the master xprv —
//! so we can derive each input's pubkey + populate `bip32_derivation`
//! origin info that `sign_psbt` will resolve later — and (b) a list of
//! inputs from the caller's UTXO set + the recipient/change parameters.
//!
//! Out of scope (v1): P2TR (BIP86) inputs (sender side), multi-recipient
//! sends, RBF-replacement of an earlier tx, manual locktime overrides.
//! Each is layered on top of the same PSBT primitive — add when needed.
//!
//! Why the master xprv is required (not just the master xpub): the
//! `bip32_derivation` map needs the master fingerprint, and the cheapest
//! way to get a stable fingerprint matching `sign_psbt`'s later view of
//! the same key is to derive both from the same xprv at PSBT-build time.
//! Callers that don't want to pass the xprv here can build a parallel
//! function from the xpub once we have one.

use bitcoin::absolute::LockTime;
use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::psbt::{Input as PsbtInput, Output as PsbtOutput, Psbt};
use bitcoin::secp256k1::Secp256k1;
use bitcoin::transaction::Version;
use bitcoin::{
    Address, Amount, CompressedPublicKey, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut,
    Txid, Witness,
};
use core::str::FromStr;
use std::collections::BTreeMap;

use crate::network::Network;

#[derive(Debug)]
pub enum BuildError {
    InvalidTxid,
    InvalidRecipient,
    InvalidChangeAddress,
    InvalidInputPath,
    InsufficientFunds {
        selected_sat: u64,
        needed_sat: u64,
    },
    DerivationFailed,
    AddressNetworkMismatch,
    DustChange,
    InvalidPsbt,
    NotFinalized,
}

impl core::fmt::Display for BuildError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            BuildError::InvalidTxid => write!(f, "invalid input txid"),
            BuildError::InvalidRecipient => write!(f, "invalid recipient address"),
            BuildError::InvalidChangeAddress => write!(f, "invalid change address"),
            BuildError::InvalidInputPath => write!(f, "invalid input BIP32 path"),
            BuildError::InsufficientFunds {
                selected_sat,
                needed_sat,
            } => write!(
                f,
                "insufficient funds: selected {} sat, need {} sat",
                selected_sat, needed_sat
            ),
            BuildError::DerivationFailed => write!(f, "BIP32 derivation failed"),
            BuildError::AddressNetworkMismatch => {
                write!(f, "recipient/change address network does not match selected network")
            }
            BuildError::DustChange => write!(f, "change output below dust limit"),
            BuildError::InvalidPsbt => write!(f, "invalid PSBT"),
            BuildError::NotFinalized => write!(f, "PSBT is not fully signed/finalized"),
        }
    }
}

impl std::error::Error for BuildError {}

/// One UTXO the caller wants to spend.
///
/// `master_path` is the BIP32 path (relative to the master xprv) where
/// this UTXO's address was derived — e.g. `m/84'/0'/0'/0/3` for the
/// fourth receive address on the first BIP84 account. This is what the
/// PSBT `bip32_derivation` map needs, and it's what makes `sign_psbt`
/// know which child key to use when signing later.
#[derive(Debug, Clone)]
pub struct UnsignedInput {
    pub txid: String,
    pub vout: u32,
    pub value_sat: u64,
    pub master_path: String,
}

/// Parameters for `build_psbt`.
pub struct BuildParams<'a> {
    pub network: Network,
    pub inputs: &'a [UnsignedInput],
    pub recipient_address: &'a str,
    pub recipient_sat: u64,
    /// Optional change output. Omit (or pass with `change_sat = 0`) to send
    /// everything net of fee to the recipient.
    pub change_address: Option<&'a str>,
    pub change_sat: u64,
    /// Master xprv — used to derive each input's pubkey + populate
    /// `bip32_derivation` origin. The xprv version bytes should match
    /// `network`; otherwise the resulting PSBT will be useless on the
    /// target chain.
    pub master_xpriv: &'a Xpriv,
}

/// P2WPKH dust limit per BIP-376 / Bitcoin Core. LTC inherits this.
pub const DUST_LIMIT_P2WPKH: u64 = 294;

/// Extract the final network-broadcastable transaction hex from a fully-
/// signed PSBT. Wraps `bitcoin::Psbt::extract_tx`, which finalizes the
/// PSBT (combining all signatures into witness scripts) and serializes
/// the resulting transaction as raw hex.
pub fn extract_tx(psbt_base64: &str) -> Result<String, BuildError> {
    use bitcoin::consensus::encode::serialize_hex;
    let psbt = Psbt::from_str(psbt_base64).map_err(|_| BuildError::InvalidPsbt)?;
    let tx = psbt.extract_tx().map_err(|_| BuildError::NotFinalized)?;
    Ok(serialize_hex(&tx))
}

/// Build an unsigned base64-encoded PSBT ready for `sign_psbt`.
///
/// Caller responsibility:
/// - UTXO selection (we assume `inputs` is the final spend set).
/// - Fee math (we trust `recipient_sat + change_sat <= sum(inputs)`;
///   the difference is the fee — we don't validate it here).
/// - Change address generation (any change goes to `change_address`;
///   pass `None` to skip).
///
/// Sequence is set to `0xfffffffd` on every input to signal RBF
/// (BIP125). Locktime is 0 — we don't use absolute locktimes for normal
/// sends.
pub fn build_psbt(params: BuildParams<'_>) -> Result<String, BuildError> {
    let total_in: u64 = params.inputs.iter().map(|i| i.value_sat).sum();
    let total_out = params.recipient_sat.saturating_add(params.change_sat);
    if total_in < total_out {
        return Err(BuildError::InsufficientFunds {
            selected_sat: total_in,
            needed_sat: total_out,
        });
    }

    // Dust-check change. The recipient amount is the user's
    // responsibility — if they ask to send dust we let them.
    if params.change_address.is_some() && params.change_sat > 0 && params.change_sat < DUST_LIMIT_P2WPKH {
        return Err(BuildError::DustChange);
    }

    let secp = Secp256k1::new();
    let btc_network = params.network.as_bitcoin_network();

    // ---- Parse recipient + change addresses ----
    let recipient =
        parse_address_for_network(params.recipient_address, params.network).ok_or(BuildError::InvalidRecipient)?;
    let change = match params.change_address {
        Some(addr) if params.change_sat > 0 => {
            Some(parse_address_for_network(addr, params.network).ok_or(BuildError::InvalidChangeAddress)?)
        }
        _ => None,
    };

    // ---- Build the unsigned transaction skeleton ----
    let tx_in: Vec<TxIn> = params
        .inputs
        .iter()
        .map(|i| {
            let txid = Txid::from_str(&i.txid).map_err(|_| BuildError::InvalidTxid)?;
            Ok(TxIn {
                previous_output: OutPoint::new(txid, i.vout),
                script_sig: ScriptBuf::new(),
                sequence: Sequence(0xfffffffd), // RBF-enabled
                witness: Witness::new(),
            })
        })
        .collect::<Result<_, BuildError>>()?;

    let mut tx_out = vec![TxOut {
        value: Amount::from_sat(params.recipient_sat),
        script_pubkey: recipient.script_pubkey(),
    }];
    if let Some(c) = &change {
        tx_out.push(TxOut {
            value: Amount::from_sat(params.change_sat),
            script_pubkey: c.script_pubkey(),
        });
    }

    let unsigned_tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: tx_in,
        output: tx_out,
    };

    // ---- Wrap as PSBT, populate per-input fields ----
    let mut psbt = Psbt::from_unsigned_tx(unsigned_tx)
        .map_err(|_| BuildError::DerivationFailed)?;
    let master_fingerprint = params.master_xpriv.fingerprint(&secp);

    for (idx, input_meta) in params.inputs.iter().enumerate() {
        let path: DerivationPath = input_meta
            .master_path
            .parse()
            .map_err(|_| BuildError::InvalidInputPath)?;
        let child_xpriv = params
            .master_xpriv
            .derive_priv(&secp, &path)
            .map_err(|_| BuildError::DerivationFailed)?;
        let child_pubkey = CompressedPublicKey::from_private_key(&secp, &child_xpriv.to_priv())
            .map_err(|_| BuildError::DerivationFailed)?;

        // P2WPKH script_pubkey from the child pubkey's hash160.
        let script_pubkey = ScriptBuf::new_p2wpkh(&child_pubkey.wpubkey_hash());

        // bip32_derivation map entry — `sign_psbt` walks this to know
        // which child key signs which input.
        let mut bip32_derivation = BTreeMap::new();
        bip32_derivation.insert(child_pubkey.0, (master_fingerprint, path));

        psbt.inputs[idx] = PsbtInput {
            witness_utxo: Some(TxOut {
                value: Amount::from_sat(input_meta.value_sat),
                script_pubkey,
            }),
            bip32_derivation,
            ..Default::default()
        };
    }

    // Empty PsbtOutput entries for each output — keeps the PSBT spec-
    // valid; signers and bookkeepers may attach metadata later.
    psbt.outputs = (0..psbt.unsigned_tx.output.len())
        .map(|_| PsbtOutput::default())
        .collect();

    // Sanity check we didn't accidentally end up on the wrong network
    // (e.g. xprv is mainnet but addresses were testnet — already caught
    // in `parse_address_for_network`, this is belt-and-suspenders).
    if params.master_xpriv.network != btc_network.into() {
        return Err(BuildError::AddressNetworkMismatch);
    }

    Ok(psbt.to_string())
}

/// Parse an address string under the given network. Rejects addresses
/// whose network params don't match (mainnet ↔ testnet mismatches).
///
/// For LTC we currently only validate the BTC-side; full LTC HRP
/// handling lives in `address.rs` and the LTC sender flow should
/// validate via that path before calling here. Returning `None` for
/// any failure keeps the call site simple.
fn parse_address_for_network(addr_str: &str, network: Network) -> Option<Address> {
    Address::from_str(addr_str)
        .ok()
        .and_then(|a| a.require_network(network.as_bitcoin_network()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bip32::mnemonic_to_xpriv;

    const ABANDON_MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn build_psbt_single_input_single_output_no_change() {
        let master =
            mnemonic_to_xpriv(ABANDON_MNEMONIC, "", Network::BtcMainnet).expect("xprv");

        // Fake UTXO: txid = 32 bytes of 0x11, vout 0, value 1 BTC.
        let inputs = vec![UnsignedInput {
            txid: "1111111111111111111111111111111111111111111111111111111111111111".to_string(),
            vout: 0,
            value_sat: 100_000_000,
            master_path: "m/84'/0'/0'/0/0".to_string(),
        }];

        let psbt_b64 = build_psbt(BuildParams {
            network: Network::BtcMainnet,
            inputs: &inputs,
            recipient_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", // BIP-173 sample
            recipient_sat: 99_000_000,
            change_address: None,
            change_sat: 0,
            master_xpriv: &master,
        })
        .expect("build_psbt");

        // Round-trip: parse back, check input + output counts.
        let psbt = Psbt::from_str(&psbt_b64).expect("parse");
        assert_eq!(psbt.inputs.len(), 1);
        assert_eq!(psbt.outputs.len(), 1);
        assert!(psbt.inputs[0].witness_utxo.is_some());
        assert_eq!(psbt.inputs[0].bip32_derivation.len(), 1);
    }

    #[test]
    fn build_psbt_with_change() {
        let master = mnemonic_to_xpriv(ABANDON_MNEMONIC, "", Network::BtcMainnet).unwrap();
        let inputs = vec![UnsignedInput {
            txid: "1111111111111111111111111111111111111111111111111111111111111111".to_string(),
            vout: 0,
            value_sat: 100_000_000,
            master_path: "m/84'/0'/0'/0/0".to_string(),
        }];

        let psbt_b64 = build_psbt(BuildParams {
            network: Network::BtcMainnet,
            inputs: &inputs,
            recipient_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            recipient_sat: 50_000_000,
            change_address: Some("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"),
            change_sat: 49_999_000, // 1000 sat fee
            master_xpriv: &master,
        })
        .expect("build_psbt with change");

        let psbt = Psbt::from_str(&psbt_b64).unwrap();
        assert_eq!(psbt.inputs.len(), 1);
        assert_eq!(psbt.outputs.len(), 2);
    }

    #[test]
    fn insufficient_funds_errors() {
        let master = mnemonic_to_xpriv(ABANDON_MNEMONIC, "", Network::BtcMainnet).unwrap();
        let inputs = vec![UnsignedInput {
            txid: "1111111111111111111111111111111111111111111111111111111111111111".to_string(),
            vout: 0,
            value_sat: 1000,
            master_path: "m/84'/0'/0'/0/0".to_string(),
        }];

        let err = build_psbt(BuildParams {
            network: Network::BtcMainnet,
            inputs: &inputs,
            recipient_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            recipient_sat: 2000,
            change_address: None,
            change_sat: 0,
            master_xpriv: &master,
        })
        .unwrap_err();
        assert!(matches!(err, BuildError::InsufficientFunds { .. }));
    }

    #[test]
    fn dust_change_errors() {
        let master = mnemonic_to_xpriv(ABANDON_MNEMONIC, "", Network::BtcMainnet).unwrap();
        let inputs = vec![UnsignedInput {
            txid: "1111111111111111111111111111111111111111111111111111111111111111".to_string(),
            vout: 0,
            value_sat: 100_000,
            master_path: "m/84'/0'/0'/0/0".to_string(),
        }];

        let err = build_psbt(BuildParams {
            network: Network::BtcMainnet,
            inputs: &inputs,
            recipient_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            recipient_sat: 99_900,
            change_address: Some("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"),
            change_sat: 100, // below DUST_LIMIT_P2WPKH = 294
            master_xpriv: &master,
        })
        .unwrap_err();
        assert!(matches!(err, BuildError::DustChange));
    }

    #[test]
    fn round_trip_through_sign_psbt() {
        // Build, then sign — sign_psbt should resolve the bip32_derivation
        // origin and produce a signed PSBT with the input filled in.
        use crate::psbt::sign_psbt;
        let master = mnemonic_to_xpriv(ABANDON_MNEMONIC, "", Network::BtcMainnet).unwrap();
        let inputs = vec![UnsignedInput {
            txid: "1111111111111111111111111111111111111111111111111111111111111111".to_string(),
            vout: 0,
            value_sat: 100_000_000,
            master_path: "m/84'/0'/0'/0/0".to_string(),
        }];
        let unsigned = build_psbt(BuildParams {
            network: Network::BtcMainnet,
            inputs: &inputs,
            recipient_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            recipient_sat: 99_999_000,
            change_address: None,
            change_sat: 0,
            master_xpriv: &master,
        })
        .unwrap();

        let (_signed_psbt, report) = sign_psbt(&unsigned, &master).expect("sign");
        assert_eq!(report.inputs_total, 1);
        assert_eq!(report.inputs_signed, 1);
    }
}
