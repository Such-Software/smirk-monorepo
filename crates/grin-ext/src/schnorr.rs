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

use k256::elliptic_curve::group::GroupEncoding;
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{FieldElement, NonZeroScalar, ProjectivePoint, PublicKey, Scalar, SecretKey, U256};
use rand_core::{CryptoRng, RngCore};
use zeroize::Zeroize;

/// True iff the Y coordinate of the compressed-form pubkey is a
/// quadratic residue mod p (secp256k1 field prime). Grin's aggsig
/// verifier reconstructs R from its X coordinate by picking the QR
/// branch (`secp256k1_ge_set_xquad` in the C lib), then requires
/// `sG - eP` to have Y QR. So signers must use a nonce whose R has
/// Y QR — if not, negate the nonce.
fn pubkey_y_is_qr(compressed: &[u8]) -> bool {
    let Ok(pk) = PublicKey::from_sec1_bytes(compressed) else {
        return false;
    };
    let encoded = pk.to_encoded_point(false); // uncompressed: 04 || X || Y
    let bytes = encoded.as_bytes();
    if bytes.len() != 65 {
        return false;
    }
    let mut y_bytes = [0u8; 32];
    y_bytes.copy_from_slice(&bytes[33..65]);
    // FieldElement::from_bytes is constant-time-conditional; for our
    // purposes Y is always a valid field element (it came from a
    // valid curve point).
    let y_opt = FieldElement::from_bytes(&y_bytes.into());
    let Some(y) = Option::<FieldElement>::from(y_opt) else {
        return false;
    };
    // Y is a quadratic residue iff `sqrt(Y)` exists.
    Option::<FieldElement>::from(y.sqrt()).is_some()
}

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
    let r_compressed_original = nonce_point.to_sec1_bytes();

    // Grin's aggsig verifier reconstructs R from R.X by picking the Y
    // that's a quadratic residue. The CHALLENGE `e` is computed from
    // that QR-form R, so the signer must use the QR-form encoding for
    // its own hashing AND negate the nonce when the original R was
    // non-QR.
    let nonce_is_qr = pubkey_y_is_qr(&r_compressed_original);
    let qr_prefix = if (r_compressed_original[0] == 0x02) == nonce_is_qr {
        0x02
    } else {
        0x03
    };
    let mut r_compressed_qr = [0u8; 33];
    r_compressed_qr[0] = qr_prefix;
    r_compressed_qr[1..].copy_from_slice(&r_compressed_original[1..]);

    let e = challenge_hash(&r_compressed_qr, &p_compressed, msg)?;

    let effective_nonce: Scalar = if nonce_is_qr {
        *nonce_scalar.as_ref()
    } else {
        -*nonce_scalar.as_ref()
    };

    // s = (k_effective + e * sk) mod n
    let s_scalar = effective_nonce + e * sk_scalar.as_ref();

    // Encode signature: R x-coord (drop parity byte) || s.
    let mut sig = [0u8; SIG_LEN];
    sig[..32].copy_from_slice(&r_compressed_qr[1..33]);
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

    // Grin aggsig convention: reconstruct R with Y QR (not even-Y).
    // Try Y=02 first; if that's QR keep it, else use Y=03.
    let mut r_even = [0u8; 33];
    r_even[0] = 0x02;
    r_even[1..].copy_from_slice(&sig.0[..32]);
    let mut r_odd = [0u8; 33];
    r_odd[0] = 0x03;
    r_odd[1..].copy_from_slice(&sig.0[..32]);
    let r_qr = if pubkey_y_is_qr(&r_even) { r_even } else { r_odd };

    let mut s_bytes = [0u8; 32];
    s_bytes.copy_from_slice(&sig.0[32..]);
    let s_scalar = scalar_from_bytes(&s_bytes).ok_or("invalid s scalar")?;

    let lhs = ProjectivePoint::GENERATOR * s_scalar;

    if let Ok(()) = check_with_r(&r_qr, &p_compressed, msg, &public_key, &lhs, &s_scalar) {
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

/// Compute the challenge hash `e = SHA256(R.X || P_compressed || msg)`,
/// reduced to a secp256k1 scalar.
///
/// Caller MUST pass `r_compressed` as 33-byte SEC1 form; we drop the
/// parity byte and feed only the 32-byte X-coordinate, matching Grin's
/// `secp256k1_compute_sighash_single` (see
/// `secp256k1-zkp/src/modules/aggsig/main_impl.h:42-58`):
/// - hash = SHA256 (NOT Blake2b — we had this wrong before, which is
///   why local self-verify passed but grin's aggsig verifier always
///   rejected with "IncorrectSignature" / "some kind of keychain
///   error" on broadcast)
/// - nonce contribution = 32 bytes (`buf+1`, X only, no parity prefix)
/// - pubkey contribution = full 33 bytes (compressed, WITH prefix)
fn challenge_hash(
    r_compressed: &[u8],
    p_compressed: &[u8],
    msg: &[u8; MSG_LEN],
) -> Result<Scalar, String> {
    use sha2::{Digest, Sha256};
    if r_compressed.len() != 33 {
        return Err(format!(
            "r_compressed must be 33-byte SEC1; got {}",
            r_compressed.len()
        ));
    }
    let mut hasher = Sha256::new();
    hasher.update(&r_compressed[1..]); // X only — strip parity byte
    hasher.update(p_compressed); // full compressed (with prefix)
    hasher.update(msg);
    let out = hasher.finalize();
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&out);
    Ok(<Scalar as Reduce<U256>>::reduce_bytes(&buf.into()))
}

/// Convert raw 32 bytes to a secp256k1 scalar, returning `None` if invalid.
fn scalar_from_bytes(bytes: &[u8; 32]) -> Option<Scalar> {
    let _ = SecretKey::from_slice(bytes).ok()?;
    use k256::elliptic_curve::scalar::FromUintUnchecked;
    Some(Scalar::from_uint_unchecked(U256::from_be_slice(bytes)))
}

// =============================================================================
// Multi-party Schnorr aggregation (Grin-style aggsig)
// =============================================================================
//
// Grin slate signing is a multi-party Schnorr aggregation: each participant
// has their own (secret_key, nonce) pair, and the final signature is the sum
// of partial signatures. The challenge hash is shared, computed once over
// the SUMS of public nonces and public keys:
//
//   R_total = R_1 + R_2 + ... + R_n         (sum of public nonces, point add)
//   P_total = P_1 + P_2 + ... + P_n         (sum of public keys, point add)
//   e       = blake2b32(R_total || P_total || msg)
//   s_i     = k_i + e * x_i                  (each participant computes own partial)
//   s_total = s_1 + s_2 + ... + s_n          (sum of partials, scalar add mod n)
//
// Final aggregate signature is `(R_total, s_total)` — the same shape and
// verification equation as a single-signer Schnorr against public key
// P_total. So verifying the final aggregate uses the same `verify` we
// already have, with `public_key_compressed = P_total`.
//
// This is plain (non-MuSig) Schnorr aggregation. Grin doesn't use MuSig's
// key-coefficient tweaks — participant authentication happens at a layer
// above (via the slate exchange protocol).

/// Add two compressed secp256k1 public keys via curve point addition.
///
/// Used to compute `R_total = R_1 + R_2` (sum of public nonces) and
/// `P_total = P_1 + P_2` (sum of public keys / blinding factor pubkeys).
pub fn point_add(a_compressed: &[u8; 33], b_compressed: &[u8; 33]) -> Result<[u8; 33], String> {
    let a = PublicKey::from_sec1_bytes(a_compressed)
        .map_err(|e| format!("invalid first pubkey: {e}"))?;
    let b = PublicKey::from_sec1_bytes(b_compressed)
        .map_err(|e| format!("invalid second pubkey: {e}"))?;
    let sum: ProjectivePoint = a.to_projective() + b.to_projective();
    let sum_pk = PublicKey::try_from(sum.to_affine())
        .map_err(|e| format!("sum is identity / invalid: {e}"))?;
    let bytes = sum_pk.to_sec1_bytes();
    if bytes.len() != 33 {
        return Err(format!("unexpected encoded length: {}", bytes.len()));
    }
    let mut out = [0u8; 33];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Sum N compressed pubkeys. Convenience over [`point_add`].
pub fn point_sum(points: &[[u8; 33]]) -> Result<[u8; 33], String> {
    if points.is_empty() {
        return Err("cannot sum zero points".to_string());
    }
    let mut acc = points[0];
    for p in &points[1..] {
        acc = point_add(&acc, p)?;
    }
    Ok(acc)
}

/// Produce a partial Schnorr signature for one participant in a multi-party
/// signing ceremony.
///
/// `secret_key` and `secret_nonce` are this participant's secrets.
/// `public_nonce_total` and `public_key_total` are the SUMS of all
/// participants' public nonces and public keys (both 33-byte compressed).
///
/// Returns the partial scalar `s_i = k_i + e · x_i` (32 bytes) where
/// `e = blake2b32(R_total || P_total || msg)`.
pub fn partial_sign(
    secret_key: &[u8; 32],
    secret_nonce: &[u8; 32],
    public_nonce_total: &[u8; 33],
    public_key_total: &[u8; 33],
    msg: &[u8; MSG_LEN],
) -> Result<[u8; 32], String> {
    let sk = NonZeroScalar::try_from(secret_key.as_slice())
        .map_err(|e| format!("invalid secret key: {e}"))?;
    let nonce = NonZeroScalar::try_from(secret_nonce.as_slice())
        .map_err(|e| format!("invalid nonce: {e}"))?;

    // MuSig with Grin's QR-Y convention: if R_total has Y that's not
    // a QR, all participants negate their local nonce so the
    // aggregated R lands on the QR branch the verifier picks. The
    // challenge is computed from the QR-form R_total (matching what
    // the verifier reconstructs).
    let r_total_is_qr = pubkey_y_is_qr(public_nonce_total);
    let qr_prefix = if (public_nonce_total[0] == 0x02) == r_total_is_qr {
        0x02
    } else {
        0x03
    };
    let mut r_total_qr = [0u8; 33];
    r_total_qr[0] = qr_prefix;
    r_total_qr[1..].copy_from_slice(&public_nonce_total[1..]);

    let nonce_scalar: Scalar = if r_total_is_qr {
        *nonce.as_ref()
    } else {
        -*nonce.as_ref()
    };

    // Shared challenge using the QR-form R_total.
    let e = challenge_hash(&r_total_qr, public_key_total, msg)?;
    eprintln!("[partial_sign] r_total_qr (33B) = {:02x?}", r_total_qr);
    eprintln!("[partial_sign] public_key_total (33B) = {:02x?}", public_key_total);
    eprintln!("[partial_sign] r_total_is_qr = {}", r_total_is_qr);
    eprintln!("[partial_sign] e (scalar BE) = {:02x?}", &e.to_bytes()[..]);
    eprintln!("[partial_sign] nonce_bytes IN = {:02x?}", secret_nonce);
    eprintln!("[partial_sign] sk_bytes IN = {:02x?}", secret_key);

    // s_i = k_i_effective + e · x_i
    let s = nonce_scalar + e * sk.as_ref();

    // DEBUG: print bytes raw vs converted
    let raw = s.to_bytes();
    let raw_slice: &[u8] = &raw;
    eprintln!("[partial_sign] s.to_bytes() raw = {:02x?}", raw_slice);
    let arr: [u8; 32] = raw.into();
    eprintln!("[partial_sign] s.to_bytes().into() = {:02x?}", arr);

    Ok(s.to_bytes().into())
}

/// Verify one participant's partial signature.
///
/// Checks `s_i · G == R_i + e · P_i` where `e` is computed using the
/// shared `R_total` and `P_total`. Returns `Ok(true)` if valid.
pub fn partial_verify(
    partial_s: &[u8; 32],
    public_nonce_i: &[u8; 33],
    public_key_i: &[u8; 33],
    public_nonce_total: &[u8; 33],
    public_key_total: &[u8; 33],
    msg: &[u8; MSG_LEN],
) -> Result<bool, String> {
    let s = scalar_from_bytes(partial_s).ok_or("invalid partial s scalar")?;
    let r_i = PublicKey::from_sec1_bytes(public_nonce_i)
        .map_err(|e| format!("invalid R_i: {e}"))?;
    let p_i = PublicKey::from_sec1_bytes(public_key_i)
        .map_err(|e| format!("invalid P_i: {e}"))?;

    // Use the QR-form R_total for both the challenge and the per-
    // participant nonce flip (matches partial_sign).
    let r_total_is_qr = pubkey_y_is_qr(public_nonce_total);
    let qr_prefix = if (public_nonce_total[0] == 0x02) == r_total_is_qr {
        0x02
    } else {
        0x03
    };
    let mut r_total_qr = [0u8; 33];
    r_total_qr[0] = qr_prefix;
    r_total_qr[1..].copy_from_slice(&public_nonce_total[1..]);

    let e = challenge_hash(&r_total_qr, public_key_total, msg)?;

    let r_i_point = if r_total_is_qr {
        r_i.to_projective()
    } else {
        -r_i.to_projective()
    };

    let lhs = ProjectivePoint::GENERATOR * s;
    let rhs = r_i_point + p_i.to_projective() * e;

    Ok(lhs.to_bytes() == rhs.to_bytes())
}

/// Aggregate N partial scalars into a single `s_total = s_1 + s_2 + ... + s_n`
/// (mod curve order).
pub fn aggregate_partials(partials: &[[u8; 32]]) -> Result<[u8; 32], String> {
    if partials.is_empty() {
        return Err("cannot aggregate zero partials".to_string());
    }
    let mut acc = scalar_from_bytes(&partials[0]).ok_or("invalid first partial")?;
    for (i, p) in partials[1..].iter().enumerate() {
        let s = scalar_from_bytes(p)
            .ok_or_else(|| format!("invalid partial #{}", i + 1))?;
        acc += s;
    }
    Ok(acc.to_bytes().into())
}

/// Build a final 64-byte aggregate signature from the shared public nonce
/// `R_total` and the aggregated scalar `s_total`.
///
/// The result verifies as a single-signer Schnorr signature against the
/// aggregate public key `P_total` — pass it to [`verify`] with `P_total` as
/// `public_key_compressed`.
pub fn final_signature(public_nonce_total: &[u8; 33], aggregate_s: &[u8; 32]) -> Signature {
    // No parity adjustment needed here. The MuSig convention handles
    // R-parity at PARTIAL SIGN time: when R_total has odd Y, each
    // participant negates their local nonce k_i (so R_i_used = -R_i_committed)
    // before computing s_i = k_i_used + e·x_i. The aggregated s then
    // already corresponds to the canonical (X, even_Y) encoding the
    // verifier reconstructs. See `partial_sign` for the negation.
    let mut sig = [0u8; SIG_LEN];
    sig[..32].copy_from_slice(&public_nonce_total[1..33]); // drop parity prefix, keep X
    sig[32..].copy_from_slice(aggregate_s);
    Signature(sig)
}


// =============================================================================
// Schnorr adaptor signatures (the v0.4 atomic swap unlock)
// =============================================================================
//
// An adaptor signature is an "incomplete" Schnorr partial that anyone with
// a particular secret scalar `t` (where the public point T = t·G is known
// to all parties) can complete into a normal, broadcastable partial.
// Conversely, anyone seeing the completed partial alongside the original
// adaptor partial can extract `t`. This is the cryptographic glue for
// trustless atomic swaps:
//
//   1. Bob picks `t`, publishes T = t·G
//   2. Bob signs the chain-A transaction with an adaptor partial keyed
//      to T (incomplete; can't broadcast yet)
//   3. Alice locks chain-B funds in a way that lets Bob spend them by
//      revealing `t` somehow (or sets up the converse)
//   4. Bob spends the chain-B output, revealing `t`
//   5. Alice (or any watcher) extracts `t` from the chain-B sig and
//      uses it to complete Bob's chain-A adaptor → broadcasts chain-A
//
// Math (multi-party Schnorr with one adaptor signer):
//
//   R_total_eff = (Σ R_i) + T
//   e           = blake2b32(R_total_eff || P_total || msg)
//   s_i'        = k_i + e · x_i              // adaptor partial (no `t`)
//
//   Completion: s_i = s_i' + t                 // valid normal partial
//   Aggregate : s   = Σ s_j (j ≠ i) + s_i      // valid aggregate
//   Final sig : (R_total_eff, s)              // verifies against P_total
//   Extraction: t   = s_i_completed - s_i'
//
// Reference: Andrew Poelstra's "Scriptless Scripts" (2018), the BIP-340
// adaptor-sig literature, and Comit Network's xmr-btc-swap production
// implementation. Same scheme as the upstream `secp256k1-zkp` aggsig
// adaptor variants; we work in pure Rust over `k256`.
//
// The "verify" side of an adaptor partial is exactly the same shape as a
// normal partial-verify — just with `R_total_eff` (which already contains T)
// in the challenge. So we expose the adaptor variants as thin wrappers that
// build R_total_eff from R_total + T and delegate to `partial_sign` /
// `partial_verify`. The new operations are `complete_adaptor` and
// `extract_adaptor_secret`.

/// Produce an adaptor partial signature. The result is INCOMPLETE: it
/// behaves like a normal partial under verification (with the offset
/// challenge), but combined with the adaptor secret `t` via
/// [`complete_adaptor`] it becomes a valid broadcastable partial.
///
/// `public_nonce_total_no_t` is the sum of all participants' individual
/// nonces — withOUT T mixed in. The function adds T internally to compute
/// the offset challenge; this matches the canonical adaptor-sig math
/// where the published signature's nonce is `(R_total_no_t + T)`.
pub fn adaptor_partial_sign(
    secret_key: &[u8; 32],
    secret_nonce: &[u8; 32],
    public_nonce_total_no_t: &[u8; 33],
    public_key_total: &[u8; 33],
    adaptor_point_t: &[u8; 33],
    msg: &[u8; MSG_LEN],
) -> Result<[u8; 32], String> {
    let r_total_eff = point_add(public_nonce_total_no_t, adaptor_point_t)?;
    partial_sign(secret_key, secret_nonce, &r_total_eff, public_key_total, msg)
}

/// Verify an adaptor partial signature. Verifies exactly the same way as
/// a regular partial — `s_prime · G == R_i + e · P_i` with the
/// challenge `e = blake2b32((R_total_no_t + T) || P_total || msg)`.
///
/// A valid result means: this partial WILL complete to a valid normal
/// partial when combined with the adaptor secret `t`. The verifier doesn't
/// learn `t` and doesn't need to.
pub fn adaptor_partial_verify(
    adaptor_partial_s: &[u8; 32],
    public_nonce_i: &[u8; 33],
    public_key_i: &[u8; 33],
    public_nonce_total_no_t: &[u8; 33],
    public_key_total: &[u8; 33],
    adaptor_point_t: &[u8; 33],
    msg: &[u8; MSG_LEN],
) -> Result<bool, String> {
    let r_total_eff = point_add(public_nonce_total_no_t, adaptor_point_t)?;
    partial_verify(
        adaptor_partial_s,
        public_nonce_i,
        public_key_i,
        &r_total_eff,
        public_key_total,
        msg,
    )
}

/// Complete an adaptor partial into a regular partial signature by adding
/// the adaptor secret `t`. The output is a 32-byte scalar that combines
/// (via [`aggregate_partials`]) into a valid aggregate signature.
pub fn complete_adaptor(
    adaptor_partial_s: &[u8; 32],
    adaptor_secret_t: &[u8; 32],
) -> Result<[u8; 32], String> {
    let s_prime = scalar_from_bytes(adaptor_partial_s).ok_or("invalid adaptor partial s")?;
    let t = scalar_from_bytes(adaptor_secret_t).ok_or("invalid adaptor secret t")?;
    let s = s_prime + t;
    Ok(s.to_bytes().into())
}

/// Extract the adaptor secret `t` from a completed partial signature given
/// the original adaptor partial. Returns `t` as 32 bytes.
///
/// This is what enables the "watch the other chain to learn the secret"
/// half of an atomic swap. The watcher sees `s = s' + t` published on
/// chain (or in a slate) and recovers `t` by subtraction.
pub fn extract_adaptor_secret(
    completed_partial_s: &[u8; 32],
    adaptor_partial_s: &[u8; 32],
) -> Result<[u8; 32], String> {
    let s = scalar_from_bytes(completed_partial_s).ok_or("invalid completed s")?;
    let s_prime = scalar_from_bytes(adaptor_partial_s).ok_or("invalid adaptor partial s")?;
    let t = s - s_prime;
    Ok(t.to_bytes().into())
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

    // =========================================================================
    // Multi-party aggregation tests
    // =========================================================================

    /// Generate a fresh non-zero secret deterministically from a seed byte.
    fn det_scalar(seed: u8) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[0] = seed;
        out[31] = seed.wrapping_add(1); // ensure non-zero
        out
    }

    fn pubkey_for(sk: &[u8; 32]) -> [u8; 33] {
        crate::secp256k1::public_key_from_secret_key(sk).unwrap()
    }

    #[test]
    fn point_add_is_commutative() {
        let p1 = pubkey_for(&det_scalar(1));
        let p2 = pubkey_for(&det_scalar(2));
        let a = point_add(&p1, &p2).unwrap();
        let b = point_add(&p2, &p1).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn point_sum_matches_repeated_point_add() {
        let p1 = pubkey_for(&det_scalar(3));
        let p2 = pubkey_for(&det_scalar(4));
        let p3 = pubkey_for(&det_scalar(5));
        let a = point_add(&point_add(&p1, &p2).unwrap(), &p3).unwrap();
        let b = point_sum(&[p1, p2, p3]).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn two_party_round_trip() {
        // Two participants each sign with their own (sk, nonce), then
        // aggregate. Final signature must verify against P_total = P_a + P_b.
        let sk_a = det_scalar(11);
        let sk_b = det_scalar(22);
        let nonce_a = det_scalar(101);
        let nonce_b = det_scalar(202);
        let msg = [99u8; 32];

        let p_a = pubkey_for(&sk_a);
        let p_b = pubkey_for(&sk_b);
        let r_a = pubkey_for(&nonce_a);
        let r_b = pubkey_for(&nonce_b);

        let p_total = point_add(&p_a, &p_b).unwrap();
        let r_total = point_add(&r_a, &r_b).unwrap();

        // Each participant produces their partial.
        let s_a = partial_sign(&sk_a, &nonce_a, &r_total, &p_total, &msg).unwrap();
        let s_b = partial_sign(&sk_b, &nonce_b, &r_total, &p_total, &msg).unwrap();

        // Each participant's partial must verify standalone.
        assert!(partial_verify(&s_a, &r_a, &p_a, &r_total, &p_total, &msg).unwrap());
        assert!(partial_verify(&s_b, &r_b, &p_b, &r_total, &p_total, &msg).unwrap());

        // Aggregate and the final must verify as a normal signature against P_total.
        let s_total = aggregate_partials(&[s_a, s_b]).unwrap();
        let final_sig = final_signature(&r_total, &s_total);
        assert!(verify(&final_sig, &msg, &p_total).unwrap());
    }

    #[test]
    fn three_party_round_trip() {
        let sks: Vec<[u8; 32]> = (1..=3).map(|i| det_scalar(i * 7)).collect();
        let nonces: Vec<[u8; 32]> = (1..=3).map(|i| det_scalar(i * 13 + 50)).collect();
        let msg = [0xab; 32];

        let pks: Vec<[u8; 33]> = sks.iter().map(pubkey_for).collect();
        let rs: Vec<[u8; 33]> = nonces.iter().map(pubkey_for).collect();
        let p_total = point_sum(&pks).unwrap();
        let r_total = point_sum(&rs).unwrap();

        let partials: Vec<[u8; 32]> = (0..3)
            .map(|i| partial_sign(&sks[i], &nonces[i], &r_total, &p_total, &msg).unwrap())
            .collect();
        for i in 0..3 {
            assert!(partial_verify(&partials[i], &rs[i], &pks[i], &r_total, &p_total, &msg).unwrap());
        }

        let s_total = aggregate_partials(&partials).unwrap();
        let final_sig = final_signature(&r_total, &s_total);
        assert!(verify(&final_sig, &msg, &p_total).unwrap());
    }

    #[test]
    fn partial_verify_rejects_wrong_message() {
        let sk = det_scalar(1);
        let nonce = det_scalar(2);
        let r = pubkey_for(&nonce);
        let p = pubkey_for(&sk);
        let msg = [3u8; 32];
        let s = partial_sign(&sk, &nonce, &r, &p, &msg).unwrap();
        // Same R/P but different message.
        let other_msg = [4u8; 32];
        assert!(!partial_verify(&s, &r, &p, &r, &p, &other_msg).unwrap());
    }

    #[test]
    fn partial_verify_rejects_wrong_partial() {
        let sk = det_scalar(1);
        let nonce = det_scalar(2);
        let r = pubkey_for(&nonce);
        let p = pubkey_for(&sk);
        let msg = [3u8; 32];
        let mut s = partial_sign(&sk, &nonce, &r, &p, &msg).unwrap();
        s[0] ^= 1;
        assert!(!partial_verify(&s, &r, &p, &r, &p, &msg).unwrap());
    }

    #[test]
    fn aggregate_of_one_equals_input() {
        let s = det_scalar(42);
        let agg = aggregate_partials(&[s]).unwrap();
        assert_eq!(agg, s);
    }

    // =========================================================================
    // Adaptor signature tests (the v0.4 atomic-swap building block)
    // =========================================================================

    /// End-to-end: two-party Schnorr sign with one party producing an
    /// ADAPTOR partial. The other party signs normally. After the adaptor
    /// secret `t` is revealed, the adaptor partial completes, partials
    /// aggregate, and the final signature verifies as a standard Schnorr
    /// against P_total with R = R_total_no_t + T.
    ///
    /// This is the cryptographic core of the v0.4 atomic-swap protocol.
    #[test]
    fn two_party_adaptor_atomic_swap_round_trip() {
        // Setup: Alice (sender) + Bob (adaptor signer). Bob picks t.
        let sk_a = det_scalar(11);
        let nonce_a = det_scalar(101);
        let sk_b = det_scalar(22);
        let nonce_b = det_scalar(102);
        let t = det_scalar(99); // Bob's adaptor secret
        let msg = [0xab; 32];

        let p_a = pubkey_for(&sk_a);
        let p_b = pubkey_for(&sk_b);
        let r_a = pubkey_for(&nonce_a);
        let r_b = pubkey_for(&nonce_b);
        let big_t = pubkey_for(&t);

        let p_total = point_add(&p_a, &p_b).unwrap();
        let r_total_no_t = point_add(&r_a, &r_b).unwrap();

        // Bob produces his ADAPTOR partial (incomplete; can't broadcast).
        let s_b_prime = adaptor_partial_sign(
            &sk_b, &nonce_b, &r_total_no_t, &p_total, &big_t, &msg,
        )
        .unwrap();

        // Alice verifies Bob's adaptor partial — confirms it WILL complete
        // to a valid partial, without learning t.
        let ok = adaptor_partial_verify(
            &s_b_prime, &r_b, &p_b, &r_total_no_t, &p_total, &big_t, &msg,
        )
        .unwrap();
        assert!(ok, "Alice must accept Bob's adaptor partial");

        // Alice produces her own NORMAL partial. Both sides use the same
        // effective R_total = R_total_no_t + T in the challenge — Alice
        // does this via the same adaptor_partial_sign helper (with her
        // own keys, no t needed for signing).
        let s_a = adaptor_partial_sign(
            &sk_a, &nonce_a, &r_total_no_t, &p_total, &big_t, &msg,
        )
        .unwrap();

        // Time passes — Bob spends the OTHER chain's UTXO, revealing t.
        // Alice (or any watcher) now completes Bob's adaptor partial.
        let s_b_completed = complete_adaptor(&s_b_prime, &t).unwrap();

        // Alice aggregates both completed partials and broadcasts.
        let s_total = aggregate_partials(&[s_a, s_b_completed]).unwrap();

        // The published signature has R = R_total_no_t + T. This is a
        // standard Schnorr signature against P_total.
        let r_total_eff = point_add(&r_total_no_t, &big_t).unwrap();
        let final_sig = final_signature(&r_total_eff, &s_total);
        assert!(verify(&final_sig, &msg, &p_total).unwrap(),
            "aggregated adaptor signature must verify as standard Schnorr against P_total");
    }

    #[test]
    fn extract_adaptor_secret_recovers_t() {
        // After the swap completes, anyone who held the original adaptor
        // partial can recover `t` by subtracting it from the completed
        // partial. This is how the OTHER side of the swap learns t.
        let s_prime = det_scalar(50);
        let t = det_scalar(7);
        let s_completed = complete_adaptor(&s_prime, &t).unwrap();
        let recovered_t = extract_adaptor_secret(&s_completed, &s_prime).unwrap();
        assert_eq!(recovered_t, t);
    }

    #[test]
    fn adaptor_partial_does_not_verify_as_regular_partial() {
        // An adaptor partial signed with the adaptor (offset) challenge
        // MUST NOT verify under the regular partial_verify path that uses
        // R_total_no_t. This protects against accidentally treating an
        // adaptor partial as a complete one.
        let sk = det_scalar(3);
        let nonce = det_scalar(4);
        let t = det_scalar(5);
        let p = pubkey_for(&sk);
        let r = pubkey_for(&nonce);
        let big_t = pubkey_for(&t);
        let msg = [42u8; 32];

        // Single-signer adaptor — R_total_no_t is just R, P_total is just P.
        let s_prime =
            adaptor_partial_sign(&sk, &nonce, &r, &p, &big_t, &msg).unwrap();

        // Adaptor verify (with T) accepts.
        assert!(adaptor_partial_verify(&s_prime, &r, &p, &r, &p, &big_t, &msg).unwrap());

        // Regular partial verify (without T) rejects.
        let regular_ok = partial_verify(&s_prime, &r, &p, &r, &p, &msg).unwrap_or(false);
        assert!(!regular_ok,
            "regular verify must reject an adaptor partial — different challenge hashes");
    }

    #[test]
    fn completed_partial_with_wrong_t_fails_aggregation_verify() {
        // If someone tries to "complete" an adaptor partial with the
        // wrong t, aggregation produces an invalid signature.
        let sk = det_scalar(1);
        let nonce = det_scalar(2);
        let t = det_scalar(7);
        let wrong_t = det_scalar(8);
        let p = pubkey_for(&sk);
        let r = pubkey_for(&nonce);
        let big_t = pubkey_for(&t);
        let msg = [9u8; 32];

        let s_prime = adaptor_partial_sign(&sk, &nonce, &r, &p, &big_t, &msg).unwrap();
        let s_wrong = complete_adaptor(&s_prime, &wrong_t).unwrap();
        let r_total_eff = point_add(&r, &big_t).unwrap();
        let bad_sig = final_signature(&r_total_eff, &s_wrong);
        assert!(!verify(&bad_sig, &msg, &p).unwrap_or(false),
            "wrong t must produce an invalid signature");
    }

    #[test]
    fn adaptor_verify_rejects_wrong_adaptor_point() {
        // If the verifier is told a different T than what the signer used,
        // the challenge hashes don't match and verify must fail.
        let sk = det_scalar(1);
        let nonce = det_scalar(2);
        let t_signer = det_scalar(3);
        let t_verifier_wrong = det_scalar(4);
        let p = pubkey_for(&sk);
        let r = pubkey_for(&nonce);
        let big_t_signer = pubkey_for(&t_signer);
        let big_t_wrong = pubkey_for(&t_verifier_wrong);
        let msg = [11u8; 32];

        let s_prime = adaptor_partial_sign(
            &sk, &nonce, &r, &p, &big_t_signer, &msg,
        )
        .unwrap();
        let ok = adaptor_partial_verify(
            &s_prime, &r, &p, &r, &p, &big_t_wrong, &msg,
        )
        .unwrap();
        assert!(!ok, "verify must reject when adaptor point doesn't match signer's");
    }
}
