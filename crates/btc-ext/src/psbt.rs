//! PSBT signing + finalization entry point.
//!
//! Two-phase per BIP174:
//!
//! 1. **Sign.** `Psbt::sign(xprv, &secp)` walks each input's
//!    `bip32_derivation` map. For every derivation whose origin matches
//!    our master xprv's fingerprint, it derives the child key and adds
//!    an entry to `input.partial_sigs`. Returns the set of pubkeys it
//!    signed with so the caller can confirm coverage.
//!
//! 2. **Finalize.** `miniscript::psbt::PsbtExt::finalize_mut` reads each
//!    input's witness/redeem script + `partial_sigs`, interprets the
//!    spending condition (for our v1 scope: P2WPKH single-sig), and
//!    builds `input.final_script_witness` — the network-format witness
//!    stack that `Psbt::extract_tx` then drops into the final
//!    transaction. **Skipping finalization is the bug that ate the
//!    morning of 2026-05-12:** signed-but-not-finalized PSBTs extract
//!    to a tx with empty witnesses, which every node rejects as "the
//!    transaction was rejected by network rules."
//!
//! v1 scope: P2WPKH (BIP84) and P2TR key-path (BIP86) single-sig inputs.
//! miniscript handles both. Multisig, Taproot script-path, and
//! hardware-signer flows land later.

use core::str::FromStr;

use bitcoin::bip32::Xpriv;
use bitcoin::psbt::Psbt;
use bitcoin::secp256k1::Secp256k1;
use miniscript::psbt::PsbtExt;

#[derive(Debug)]
pub enum PsbtError {
    InvalidPsbt,
    SignFailed,
    FinalizeFailed(String),
}

impl core::fmt::Display for PsbtError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            PsbtError::InvalidPsbt => write!(f, "could not parse PSBT"),
            PsbtError::SignFailed => write!(f, "PSBT signing failed"),
            PsbtError::FinalizeFailed(msg) => write!(f, "PSBT finalization failed: {msg}"),
        }
    }
}

impl std::error::Error for PsbtError {}

#[derive(Debug, Default)]
pub struct SignReport {
    pub inputs_total: usize,
    pub inputs_signed: usize,
}

/// Parse a base64-encoded PSBT, sign every input this xprv can sign,
/// finalize the result, and return the network-ready PSBT (still
/// base64-encoded) plus a summary of what was signed.
///
/// Inputs whose `bip32_derivation` origin doesn't match this xprv are
/// left in their pre-existing state — correct behavior for multi-signer
/// flows where another party finishes the signing. In that scenario the
/// finalization step skips them (miniscript only finalizes inputs whose
/// spend conditions are satisfied), and the caller would re-finalize
/// after the other signers have signed too. For Smirk's v0.3 single-
/// signer flow every input is ours, so finalization always covers the
/// whole tx.
pub fn sign_psbt(psbt_base64: &str, xprv: &Xpriv) -> Result<(String, SignReport), PsbtError> {
    let mut psbt = Psbt::from_str(psbt_base64).map_err(|_| PsbtError::InvalidPsbt)?;
    let secp = Secp256k1::new();
    let inputs_total = psbt.inputs.len();

    let signed_keys = psbt.sign(xprv, &secp).map_err(|_| PsbtError::SignFailed)?;

    // Finalize every input we just signed. miniscript builds
    // `final_script_witness` from the `partial_sigs` entries we
    // populated above, so `Psbt::extract_tx` afterwards yields a
    // network-format transaction (otherwise: empty witnesses → every
    // node rejects).
    psbt.finalize_mut(&secp).map_err(|errs| {
        let summary = errs
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        PsbtError::FinalizeFailed(summary)
    })?;

    let report = SignReport {
        inputs_total,
        inputs_signed: signed_keys.len(),
    };
    Ok((psbt.to_string(), report))
}

