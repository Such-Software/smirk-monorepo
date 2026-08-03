//! Bulletproof range proofs and Pedersen commitments over secp256k1.
//!
//! Thin wrapper over the vendored `secp256k1zkp` crate (Grin's fork of
//! `rust-secp256k1-zkp` at v0.7.15, in `crates/secp256k1zkp/`, patched for
//! `wasm32-unknown-unknown`).
//!
//! Grin uses **the original Bulletproofs (BP), not BP+**; see
//! `grin/core/src/libtx/proof.rs` which calls `secp.bullet_proof(...)`. The
//! wrappers here use the same C library functions (`secp256k1_bulletproof_*`)
//! so output is byte-equivalent to what `grin-wallet` produces.
//!
//! ## What this module exposes
//!
//! - [`pedersen_commit`]: commit to a `(value, blinding_factor)` pair,
//!   producing a 33-byte commitment that hides the value.
//! - [`bullet_proof_create`]: produce a range proof showing the committed
//!   value lies in `[0, 2^64)`.
//! - [`bullet_proof_verify`]: verify a range proof against a commitment.
//! - [`bullet_proof_rewind`]: recover the committed value and blinding
//!   factor from a proof, given the rewind nonce.
//!
//! Range proofs are mandatory on every Grin transaction output. Without
//! them, this crate can parse and forward existing slates but cannot
//! construct new outputs.

use secp256k1zkp::pedersen::{Commitment, ProofMessage, RangeProof};
use secp256k1zkp::{ContextFlag, Secp256k1, SecretKey};

/// Length of a Pedersen commitment in bytes.
pub const COMMITMENT_LEN: usize = 33;

/// Create a Pedersen commitment to `(value, blinding_factor)`.
///
/// Returns 33 bytes: `0x09` parity prefix + 32-byte X coordinate (Grin's
/// commitment format, slightly different from a compressed secp256k1
/// pubkey because the Y-parity is stored as `0x08`/`0x09`).
pub fn pedersen_commit(value: u64, blinding_factor: &[u8; 32]) -> Result<[u8; COMMITMENT_LEN], String> {
    let secp = Secp256k1::with_caps(ContextFlag::Commit);
    let blind = SecretKey::from_slice(&secp, blinding_factor)
        .map_err(|e| format!("invalid blinding factor: {e:?}"))?;

    let commit = secp
        .commit(value, blind)
        .map_err(|e| format!("commit failed: {e:?}"))?;

    Ok(commit.0)
}

/// Create a Bulletproof range proof showing that `value` is committed
/// inside the Pedersen commitment, with `value` in `[0, 2^64)`.
///
/// `blinding_factor` must match the one used to create the commitment.
/// `rewind_nonce` is used by the receiver later to recover the value via
/// [`bullet_proof_rewind`]. `private_nonce` should be a fresh CSPRNG
/// secret known only to the prover.
///
/// Returns the variable-length proof bytes (typically ~676 bytes for a
/// 64-bit range with no aggregation).
pub fn bullet_proof_create(
    value: u64,
    blinding_factor: &[u8; 32],
    rewind_nonce: &[u8; 32],
    private_nonce: &[u8; 32],
) -> Result<Vec<u8>, String> {
    let secp = Secp256k1::with_caps(ContextFlag::Commit);
    let blind = SecretKey::from_slice(&secp, blinding_factor)
        .map_err(|e| format!("invalid blinding factor: {e:?}"))?;
    let rewind = SecretKey::from_slice(&secp, rewind_nonce)
        .map_err(|e| format!("invalid rewind nonce: {e:?}"))?;
    let private = SecretKey::from_slice(&secp, private_nonce)
        .map_err(|e| format!("invalid private nonce: {e:?}"))?;

    let proof = secp.bullet_proof(value, blind, rewind, private, None, None);
    Ok(proof.proof[..proof.plen].to_vec())
}

/// Create a Bulletproof that embeds a 20-byte proof `message`: the v3
/// identifier message produced by [`crate::build_v3_proof_message`].
///
/// Identical to [`bullet_proof_create`] except the proof carries the
/// message that [`crate::recover_output`] parses to recover the output's
/// derivation path. **Without the message, a recovered output yields a
/// value but no spendable path** (`check_output` can't re-derive the
/// commitment). This mirrors grin's `ProofBuilder` create flow in
/// `grin/core/src/libtx/proof.rs` (`secp.bullet_proof(.., Some(message))`).
/// The underlying lib pads/truncates the message to `BULLET_PROOF_MSG_SIZE`
/// (20); we always pass exactly 20.
pub fn bullet_proof_create_with_message(
    value: u64,
    blinding_factor: &[u8; 32],
    rewind_nonce: &[u8; 32],
    private_nonce: &[u8; 32],
    message: &[u8; 20],
) -> Result<Vec<u8>, String> {
    let secp = Secp256k1::with_caps(ContextFlag::Commit);
    let blind = SecretKey::from_slice(&secp, blinding_factor)
        .map_err(|e| format!("invalid blinding factor: {e:?}"))?;
    let rewind = SecretKey::from_slice(&secp, rewind_nonce)
        .map_err(|e| format!("invalid rewind nonce: {e:?}"))?;
    let private = SecretKey::from_slice(&secp, private_nonce)
        .map_err(|e| format!("invalid private nonce: {e:?}"))?;

    let msg = ProofMessage::from_bytes(message);
    let proof = secp.bullet_proof(value, blind, rewind, private, None, Some(msg));
    Ok(proof.proof[..proof.plen].to_vec())
}

/// Verify a Bulletproof against a commitment.
///
/// Returns `Ok(true)` if the proof is valid for the commitment,
/// `Ok(false)` if invalid, `Err(_)` on malformed inputs.
pub fn bullet_proof_verify(
    commitment: &[u8; COMMITMENT_LEN],
    proof_bytes: &[u8],
) -> Result<bool, String> {
    let secp = Secp256k1::with_caps(ContextFlag::Commit);
    let commit = Commitment::from_vec(commitment.to_vec());
    let mut proof = RangeProof {
        proof: [0u8; secp256k1zkp::constants::MAX_PROOF_SIZE],
        plen: proof_bytes.len(),
    };
    if proof_bytes.len() > secp256k1zkp::constants::MAX_PROOF_SIZE {
        return Err(format!("proof too large: {} bytes", proof_bytes.len()));
    }
    proof.proof[..proof_bytes.len()].copy_from_slice(proof_bytes);

    Ok(secp.verify_bullet_proof(commit, proof, None).is_ok())
}

/// Rewind a Bulletproof using the rewind nonce, recovering the committed
/// value and blinding factor.
///
/// Used by the receiver of a transaction to confirm the amount they're
/// being paid (which is otherwise hidden inside the Pedersen commitment).
///
/// Returns `Ok(Some((value, blinding_factor)))` on successful rewind,
/// `Ok(None)` if the nonce doesn't match, `Err(_)` on malformed inputs.
pub fn bullet_proof_rewind(
    commitment: &[u8; COMMITMENT_LEN],
    rewind_nonce: &[u8; 32],
    proof_bytes: &[u8],
) -> Result<Option<(u64, [u8; 32])>, String> {
    let secp = Secp256k1::with_caps(ContextFlag::Commit);
    let commit = Commitment::from_vec(commitment.to_vec());
    let nonce = SecretKey::from_slice(&secp, rewind_nonce)
        .map_err(|e| format!("invalid rewind nonce: {e:?}"))?;

    let mut proof = RangeProof {
        proof: [0u8; secp256k1zkp::constants::MAX_PROOF_SIZE],
        plen: proof_bytes.len(),
    };
    if proof_bytes.len() > secp256k1zkp::constants::MAX_PROOF_SIZE {
        return Err(format!("proof too large: {} bytes", proof_bytes.len()));
    }
    proof.proof[..proof_bytes.len()].copy_from_slice(proof_bytes);

    match secp.rewind_bullet_proof(commit, nonce, None, proof) {
        Ok(info) => {
            // ProofInfo has fields `value: u64`, `blinding: SecretKey`.
            let mut blind_out = [0u8; 32];
            blind_out.copy_from_slice(&info.blinding[..]);
            Ok(Some((info.value, blind_out)))
        }
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Three deterministic 32-byte test scalars: values chosen to be
    /// non-zero and well-distributed; not derived from any seed.
    const BLIND: [u8; 32] = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
        21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    ];
    const REWIND: [u8; 32] = [42u8; 32];
    const PRIVATE: [u8; 32] = [7u8; 32];
    const VALUE: u64 = 1_234_567_890;

    #[test]
    fn pedersen_commit_is_deterministic() {
        let c1 = pedersen_commit(VALUE, &BLIND).unwrap();
        let c2 = pedersen_commit(VALUE, &BLIND).unwrap();
        assert_eq!(c1, c2);
    }

    #[test]
    fn pedersen_commit_changes_with_value() {
        let c1 = pedersen_commit(VALUE, &BLIND).unwrap();
        let c2 = pedersen_commit(VALUE + 1, &BLIND).unwrap();
        assert_ne!(c1, c2);
    }

    #[test]
    fn pedersen_commit_changes_with_blinding() {
        let mut other_blind = BLIND;
        other_blind[0] ^= 1;
        let c1 = pedersen_commit(VALUE, &BLIND).unwrap();
        let c2 = pedersen_commit(VALUE, &other_blind).unwrap();
        assert_ne!(c1, c2);
    }

    #[test]
    fn bullet_proof_round_trip_create_and_verify() {
        let commit = pedersen_commit(VALUE, &BLIND).unwrap();
        let proof = bullet_proof_create(VALUE, &BLIND, &REWIND, &PRIVATE).unwrap();
        assert!(bullet_proof_verify(&commit, &proof).unwrap());
    }

    #[test]
    fn bullet_proof_verify_rejects_wrong_commit() {
        let commit_a = pedersen_commit(VALUE, &BLIND).unwrap();
        let proof = bullet_proof_create(VALUE, &BLIND, &REWIND, &PRIVATE).unwrap();
        // Different value → different commit → proof should not verify
        let commit_b = pedersen_commit(VALUE + 1, &BLIND).unwrap();
        assert!(bullet_proof_verify(&commit_a, &proof).unwrap());
        assert!(!bullet_proof_verify(&commit_b, &proof).unwrap());
    }

    #[test]
    fn bullet_proof_rewind_recovers_value() {
        let commit = pedersen_commit(VALUE, &BLIND).unwrap();
        let proof = bullet_proof_create(VALUE, &BLIND, &REWIND, &PRIVATE).unwrap();
        let recovered = bullet_proof_rewind(&commit, &REWIND, &proof).unwrap();
        assert!(recovered.is_some(), "rewind should recover with correct nonce");
        let (value, blinding) = recovered.unwrap();
        assert_eq!(value, VALUE, "rewind must recover the original committed value");

        // The blinding factor that rewind returns is derived deterministically
        // from the rewind nonce; it is NOT the original blinding factor the
        // prover used. (This is intentional in Grin's design: the receiver
        // doesn't need to learn the sender's blind; they get a usable blind
        // they can compute themselves and spend the output with.)
        // We only assert it's non-zero.
        assert_ne!(blinding, [0u8; 32], "recovered blinding factor should be non-zero");
    }

    #[test]
    fn bullet_proof_rewind_with_wrong_nonce_does_not_recover_original_value() {
        let commit = pedersen_commit(VALUE, &BLIND).unwrap();
        let proof = bullet_proof_create(VALUE, &BLIND, &REWIND, &PRIVATE).unwrap();
        let mut wrong_nonce = REWIND;
        wrong_nonce[0] ^= 1;
        let result = bullet_proof_rewind(&commit, &wrong_nonce, &proof).unwrap();
        // Wrong-nonce rewind either fails (None) or returns Some with a
        // value that is NOT the original. Either is acceptable; what's not
        // acceptable is recovering the original value with a wrong nonce.
        if let Some((value, _)) = result {
            assert_ne!(value, VALUE, "wrong nonce should not recover original value");
        }
    }
}
