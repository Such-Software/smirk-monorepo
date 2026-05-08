//! Schnorr signature scheme over secp256k1, matching Grin's `aggsig` module.
//!
//! Grin uses a Schnorr variant (predates BIP-340) implemented in
//! libsecp256k1-zkp's `aggsig` module. The single-signer case is what we
//! implement here; multi-party aggregation lands in a future commit when
//! v0.4 swap work needs it.
//!
//! ## Algorithm
//!
//! Sign:
//! ```text
//!   k = nonce (provided or sampled)
//!   R = k · G                                  // 33-byte compressed
//!   P = sk · G                                  // 33-byte compressed
//!   e = blake2b32(R_compressed || P_compressed || msg)
//!   s = (k + e · sk) mod n
//!   sig = R_x_only (32) || s (32)               // 64-byte compact
//! ```
//!
//! Verify:
//! ```text
//!   parse R from sig[0..32] (recovering even-Y point)
//!   parse s from sig[32..64]
//!   e = blake2b32(R_compressed || P_compressed || msg)
//!   check s·G == R + e·P
//! ```
//!
//! ## Wire format note
//!
//! This implementation produces a self-consistent (sign, verify) pair —
//! signatures we generate verify with our verify function. Byte-for-byte
//! interop with `grin-wallet`-produced signatures is **not yet verified**
//! against fixture signatures; that's a TODO before any Grin transaction
//! involving our signature lands on mainnet. The challenge-hash construction
//! (BLAKE2b32 over compressed R, compressed P, message) matches what Grin's
//! aggsig docs describe, but exact byte format details (esp. R encoding)
//! need cross-validation with libsecp256k1-zkp.

use blake2::{digest::{Update, VariableOutput}, Blake2bVar};
use k256::elliptic_curve::group::GroupEncoding;
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{NonZeroScalar, ProjectivePoint, PublicKey, Scalar, SecretKey, U256};
use rand_core::{CryptoRng, RngCore};
use zeroize::Zeroize;

/// Length of a Grin-style compact Schnorr signature: 32-byte R x-coord + 32-byte s.
pub const SIG_LEN: usize = 64;

/// Length of a 32-byte Schnorr message hash.
pub const MSG_LEN: usize = 32;

/// A Grin-style Schnorr signature in 64-byte compact format.
///
/// Layout: `bytes[0..32]` = R x-coordinate, `bytes[32..64]` = s scalar.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Signature(pub [u8; SIG_LEN]);

impl Signature {
    /// Construct from raw 64 bytes without validation. Caller must ensure the
    /// bytes came from `sign()` or are a verified signature.
    pub fn from_bytes(bytes: [u8; SIG_LEN]) -> Self {
        Self(bytes)
    }

    /// Hex encoding for test fixtures and JSON round-trips.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
}

/// Sign a 32-byte message digest with a secret key, using the provided nonce.
///
/// Provide `secret_nonce` from a CSPRNG that must NEVER repeat across calls
/// with the same secret key. Reusing a nonce leaks the secret key.
///
/// Most callers should use [`sign`] which samples a nonce internally.
pub fn sign_with_nonce(
    secret_key: &[u8; 32],
    secret_nonce: &[u8; 32],
    msg: &[u8; MSG_LEN],
) -> Result<Signature, String> {
    let sk_scalar = NonZeroScalar::try_from(secret_key.as_slice())
        .map_err(|e| format!("invalid secret key: {e}"))?;
    let nonce_scalar = NonZeroScalar::try_from(secret_nonce.as_slice())
        .map_err(|e| format!("invalid nonce: {e}"))?;

    let public_key = PublicKey::from_secret_scalar(&sk_scalar);
    let nonce_point = PublicKey::from_secret_scalar(&nonce_scalar);

    let p_compressed = public_key.to_sec1_bytes();
    let r_compressed = nonce_point.to_sec1_bytes();

    let e = challenge_hash(&r_compressed, &p_compressed, msg)?;

    // s = (k + e * sk) mod n
    let s_scalar = nonce_scalar.as_ref() + e * sk_scalar.as_ref();

    // Encode signature: R x-coord (drop parity byte) || s.
    let mut sig = [0u8; SIG_LEN];
    sig[..32].copy_from_slice(&r_compressed[1..33]);
    sig[32..].copy_from_slice(&s_scalar.to_bytes());

    Ok(Signature(sig))
}

/// Sign a 32-byte message with a CSPRNG-sampled nonce.
pub fn sign<R: RngCore + CryptoRng>(
    rng: &mut R,
    secret_key: &[u8; 32],
    msg: &[u8; MSG_LEN],
) -> Result<Signature, String> {
    // Sample a non-zero scalar as the secret nonce. Retry if we hit the
    // zero scalar (probability ~2^-256 — never happens in practice).
    let mut nonce_bytes = [0u8; 32];
    loop {
        rng.try_fill_bytes(&mut nonce_bytes).map_err(|e| format!("rng: {e}"))?;
        if NonZeroScalar::try_from(nonce_bytes.as_slice()).is_ok() {
            break;
        }
    }

    let sig = sign_with_nonce(secret_key, &nonce_bytes, msg);
    nonce_bytes.zeroize();
    sig
}

/// Verify a 64-byte compact signature against a 32-byte message and a
/// compressed (33-byte) secp256k1 public key.
pub fn verify(
    sig: &Signature,
    msg: &[u8; MSG_LEN],
    public_key_compressed: &[u8; 33],
) -> Result<bool, String> {
    let public_key = PublicKey::from_sec1_bytes(public_key_compressed)
        .map_err(|e| format!("invalid public key: {e}"))?;
    let p_compressed = public_key.to_sec1_bytes();

    // Reconstruct R from x-only encoding by trying both parity values.
    // Try even Y first (standard convention); if that fails, try odd.
    let mut r_compressed_even = [0u8; 33];
    r_compressed_even[0] = 0x02;
    r_compressed_even[1..].copy_from_slice(&sig.0[..32]);

    let mut r_compressed_odd = [0u8; 33];
    r_compressed_odd[0] = 0x03;
    r_compressed_odd[1..].copy_from_slice(&sig.0[..32]);

    let mut s_bytes = [0u8; 32];
    s_bytes.copy_from_slice(&sig.0[32..]);
    let s_scalar = scalar_from_bytes(&s_bytes).ok_or("invalid s scalar")?;

    // s·G
    let lhs = ProjectivePoint::GENERATOR * s_scalar;

    // Try even-Y R first.
    if let Ok(()) = check_with_r(&r_compressed_even, &p_compressed, msg, &public_key, &lhs, &s_scalar) {
        return Ok(true);
    }
    if let Ok(()) = check_with_r(&r_compressed_odd, &p_compressed, msg, &public_key, &lhs, &s_scalar) {
        return Ok(true);
    }

    Ok(false)
}

/// Helper: try to verify with a specific R parity. Returns Ok if the
/// equation holds, Err otherwise (caller tries the other parity).
fn check_with_r(
    r_compressed: &[u8; 33],
    p_compressed: &[u8],
    msg: &[u8; MSG_LEN],
    public_key: &PublicKey,
    lhs: &ProjectivePoint,
    _s_scalar: &Scalar,
) -> Result<(), ()> {
    let r_point = PublicKey::from_sec1_bytes(r_compressed).map_err(|_| ())?;
    let r_proj: ProjectivePoint = r_point.into();
    let p_proj: ProjectivePoint = (*public_key).into();

    let e = challenge_hash(r_compressed, p_compressed, msg).map_err(|_| ())?;
    let rhs = r_proj + p_proj * e;

    // Compare points via their compressed encoding.
    let lhs_bytes = lhs.to_bytes();
    let rhs_bytes = rhs.to_bytes();
    if lhs_bytes == rhs_bytes {
        Ok(())
    } else {
        Err(())
    }
}

/// Compute the challenge hash `e = BLAKE2b-256(R_compressed || P_compressed || msg)`,
/// reduced to a secp256k1 scalar.
fn challenge_hash(
    r_compressed: &[u8],
    p_compressed: &[u8],
    msg: &[u8; MSG_LEN],
) -> Result<Scalar, String> {
    let mut hasher = Blake2bVar::new(32).map_err(|e| format!("blake2b init: {e}"))?;
    hasher.update(r_compressed);
    hasher.update(p_compressed);
    hasher.update(msg);

    let mut out = [0u8; 32];
    hasher
        .finalize_variable(&mut out)
        .map_err(|e| format!("blake2b finalize: {e}"))?;

    // Reduce hash to a scalar modulo curve order.
    Ok(<Scalar as Reduce<U256>>::reduce_bytes(&out.into()))
}

/// Convert raw 32 bytes to a secp256k1 scalar, returning `None` if invalid.
fn scalar_from_bytes(bytes: &[u8; 32]) -> Option<Scalar> {
    let _ = SecretKey::from_slice(bytes).ok()?;
    use k256::elliptic_curve::scalar::FromUintUnchecked;
    Some(Scalar::from_uint_unchecked(U256::from_be_slice(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test secret + nonce vector — both deterministic non-zero scalars.
    const SK: [u8; 32] = [
        0x43, 0x03, 0xf9, 0x02, 0x3f, 0x1b, 0x99, 0xad,
        0xcc, 0xf5, 0x5b, 0xbb, 0x3a, 0xb0, 0xe3, 0xdc,
        0x05, 0xb8, 0x95, 0x2a, 0x97, 0xb1, 0x3e, 0x5c,
        0x21, 0xb3, 0x7f, 0xe7, 0x6b, 0x51, 0x05, 0x0e,
    ];
    const NONCE: [u8; 32] = [
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
    ];
    const MSG: [u8; 32] = [42u8; 32];

    fn pubkey_compressed_for(sk: &[u8; 32]) -> [u8; 33] {
        crate::secp256k1::public_key_from_secret_key(sk).unwrap()
    }

    #[test]
    fn sign_verify_roundtrip_with_fixed_nonce() {
        let sig = sign_with_nonce(&SK, &NONCE, &MSG).expect("sign");
        let pk = pubkey_compressed_for(&SK);
        assert!(verify(&sig, &MSG, &pk).expect("verify runs"));
    }

    #[test]
    fn signature_is_deterministic_for_fixed_nonce() {
        let sig_a = sign_with_nonce(&SK, &NONCE, &MSG).unwrap();
        let sig_b = sign_with_nonce(&SK, &NONCE, &MSG).unwrap();
        assert_eq!(sig_a.to_hex(), sig_b.to_hex());
    }

    #[test]
    fn sign_with_random_nonce_round_trips() {
        use rand_core::OsRng;
        let sig = sign(&mut OsRng, &SK, &MSG).expect("sign with rng");
        let pk = pubkey_compressed_for(&SK);
        assert!(verify(&sig, &MSG, &pk).unwrap());
    }

    #[test]
    fn verify_rejects_wrong_message() {
        let sig = sign_with_nonce(&SK, &NONCE, &MSG).unwrap();
        let pk = pubkey_compressed_for(&SK);
        let wrong_msg = [0u8; 32];
        assert!(!verify(&sig, &wrong_msg, &pk).unwrap());
    }

    #[test]
    fn verify_rejects_wrong_pubkey() {
        let sig = sign_with_nonce(&SK, &NONCE, &MSG).unwrap();
        let other_sk = [7u8; 32];
        let other_pk = pubkey_compressed_for(&other_sk);
        assert!(!verify(&sig, &MSG, &other_pk).unwrap());
    }

    #[test]
    fn verify_rejects_tampered_signature() {
        let mut sig = sign_with_nonce(&SK, &NONCE, &MSG).unwrap();
        sig.0[0] ^= 1;
        let pk = pubkey_compressed_for(&SK);
        let result = verify(&sig, &MSG, &pk).unwrap_or(false);
        assert!(!result);
    }
}
