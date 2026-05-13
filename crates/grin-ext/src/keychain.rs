//! Grin keychain derivation — BIP32 + switch commitment adjustment.
//!
//! Grin builds blinding factors from a wallet's extended private key in
//! two steps:
//!
//! 1. BIP32-derive a child secret key along the output's identifier
//!    path (typically 4 levels of `u32`).
//! 2. If the output uses a "switch commitment" (the default for all
//!    spendable outputs since Hard Fork 2), adjust the child key via
//!    `blind_switch(amount, child_key)` — an HMAC-style offset using
//!    the secp256k1-zkp `J` generator that makes Pedersen commitments
//!    quantum-resistant under a future cryptographic migration.
//!
//! The `Regular` switch type produces what shows up on chain. `None`
//! exists for legacy / address-key paths where the raw BIP32 child
//! key is used directly.
//!
//! Matches `grin_keychain::ExtKeychain::derive_key` byte-for-byte.

use secp256k1zkp::key::SecretKey;
use secp256k1zkp::ContextFlag;
use secp256k1zkp::Secp256k1;

use crate::bip32::derive_path;

/// Switch commitment type per Grin's keychain. `Regular` is the
/// default for every on-chain output today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwitchCommitmentType {
    /// Return the raw BIP32-derived child key as the blind.
    None,
    /// Apply `blind_switch(value, child_key)` per
    /// secp256k1-zkp's adjustment using the `J` generator.
    Regular,
}

/// Derive a 32-byte blinding factor for a Grin output (or input).
///
/// 1. BIP32-derive the child key along `path` from `extended_private_key`.
/// 2. If `switch == Regular`, apply `blind_switch(amount, child_key)`.
///
/// Returns the resulting scalar in big-endian 32-byte form.
pub fn derive_blind(
    extended_private_key: &[u8; 64],
    path: &[u32],
    amount: u64,
    switch: SwitchCommitmentType,
) -> Result<[u8; 32], String> {
    let secret = derive_path(extended_private_key, path)?;
    match switch {
        SwitchCommitmentType::None => Ok(secret),
        SwitchCommitmentType::Regular => {
            // The "Commit" context flag is required for blind_switch —
            // it pulls in the generator tables needed for the J offset.
            let secp = Secp256k1::with_caps(ContextFlag::Commit);
            let child = SecretKey::from_slice(&secp, &secret)
                .map_err(|e| format!("invalid BIP32 child key as secret: {e}"))?;
            let switched = secp
                .blind_switch(amount, child)
                .map_err(|e| format!("blind_switch failed: {e}"))?;
            let mut out = [0u8; 32];
            out.copy_from_slice(&switched.0);
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Switch=None must return the raw BIP32 child key unchanged.
    #[test]
    fn switch_none_returns_bip32_child_key_directly() {
        let mut ext = [0u8; 64];
        ext[..32].copy_from_slice(&[0x42u8; 32]);
        ext[32..].copy_from_slice(&[0x77u8; 32]);
        let path = [0, 0, 1, 0];
        let amount = 1_000_000_000u64;

        let raw = derive_path(&ext, &path).unwrap();
        let derived = derive_blind(&ext, &path, amount, SwitchCommitmentType::None).unwrap();

        assert_eq!(raw, derived, "Switch=None passes BIP32 child key through unchanged");
    }

    /// Switch=Regular produces a different scalar than the raw child
    /// key (because blind_switch adds the J-generator hash offset).
    /// Without this property, the switch step is silently a no-op.
    #[test]
    fn switch_regular_differs_from_raw_child_key() {
        let mut ext = [0u8; 64];
        ext[..32].copy_from_slice(&[0x42u8; 32]);
        ext[32..].copy_from_slice(&[0x77u8; 32]);
        let path = [0, 0, 1, 0];
        let amount = 1_000_000_000u64;

        let raw = derive_blind(&ext, &path, amount, SwitchCommitmentType::None).unwrap();
        let switched =
            derive_blind(&ext, &path, amount, SwitchCommitmentType::Regular).unwrap();

        assert_ne!(raw, switched, "Switch=Regular must adjust the BIP32 child key");
    }

    /// Switch=Regular is deterministic for fixed (ext_key, path, amount):
    /// no internal randomness, every call returns the same scalar.
    #[test]
    fn switch_regular_is_deterministic() {
        let mut ext = [0u8; 64];
        ext[..32].copy_from_slice(&[0x42u8; 32]);
        ext[32..].copy_from_slice(&[0x77u8; 32]);
        let path = [0, 0, 1, 0];
        let amount = 1_000_000_000u64;

        let a = derive_blind(&ext, &path, amount, SwitchCommitmentType::Regular).unwrap();
        let b = derive_blind(&ext, &path, amount, SwitchCommitmentType::Regular).unwrap();
        assert_eq!(a, b);
    }

    /// Switch=Regular depends on the amount — changing the amount
    /// changes the resulting scalar (the J-offset depends on the
    /// commitment, which depends on the amount).
    #[test]
    fn switch_regular_depends_on_amount() {
        let mut ext = [0u8; 64];
        ext[..32].copy_from_slice(&[0x42u8; 32]);
        ext[32..].copy_from_slice(&[0x77u8; 32]);
        let path = [0, 0, 1, 0];

        let a = derive_blind(&ext, &path, 100, SwitchCommitmentType::Regular).unwrap();
        let b = derive_blind(&ext, &path, 200, SwitchCommitmentType::Regular).unwrap();
        assert_ne!(a, b);
    }
}
