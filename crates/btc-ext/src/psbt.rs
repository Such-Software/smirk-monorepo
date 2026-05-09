//! PSBT signing entry point.
//!
//! v1 scope: take a PSBT (BIP174) and a master xprv, walk the inputs, and
//! sign every input whose `bip32_derivation` paths trace back to our
//! master fingerprint. Supports P2WPKH and P2TR (BIP86 key-path) inputs.
//!
//! Out of scope (v1): script-path Taproot spends, multisig, hardware-
//! signer integration. All of those are layered on top of the same PSBT
//! flow and can be added incrementally.

use core::str::FromStr;

use bitcoin::bip32::Xpriv;
use bitcoin::psbt::Psbt;
use bitcoin::secp256k1::Secp256k1;

#[derive(Debug)]
pub enum PsbtError {
    InvalidPsbt,
    SignFailed,
}

impl core::fmt::Display for PsbtError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            PsbtError::InvalidPsbt => write!(f, "could not parse PSBT"),
            PsbtError::SignFailed => write!(f, "PSBT signing failed"),
        }
    }
}

impl std::error::Error for PsbtError {}

#[derive(Debug, Default)]
pub struct SignReport {
    pub inputs_total: usize,
    pub inputs_signed: usize,
}

/// Parse a base64-encoded PSBT, sign every input that this xprv can sign,
/// and return the updated PSBT (still base64-encoded) plus a summary of
/// what was signed.
///
/// rust-bitcoin's `Psbt::sign` walks the `bip32_derivation` map on each
/// input and signs with whichever child key matches the xprv's
/// (fingerprint, path) origin info. Inputs whose origin doesn't match
/// this xprv are left untouched — correct behavior for multi-signer flows.
pub fn sign_psbt(psbt_base64: &str, xprv: &Xpriv) -> Result<(String, SignReport), PsbtError> {
    let mut psbt = Psbt::from_str(psbt_base64).map_err(|_| PsbtError::InvalidPsbt)?;
    let secp = Secp256k1::new();
    let inputs_total = psbt.inputs.len();

    let signed_keys = psbt.sign(xprv, &secp).map_err(|_| PsbtError::SignFailed)?;

    let report = SignReport {
        inputs_total,
        inputs_signed: signed_keys.len(),
    };
    Ok((psbt.to_string(), report))
}

