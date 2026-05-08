//! secp256k1 helpers used across Grin protocol code.
//!
//! Grin's signature scheme is Schnorr over secp256k1, with public keys
//! distributed in compressed SEC1 form (33 bytes: `0x02` or `0x03` parity
//! prefix followed by the 32-byte X coordinate).
//!
//! We use the pure-Rust [`k256`] crate so the build compiles cleanly to
//! `wasm32-unknown-unknown` without C bindings or extra setup steps. This
//! is slower than `libsecp256k1` (the C implementation) for batch
//! operations, but the wallet rarely runs hot paths — readability and
//! WASM portability beat raw throughput.

use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{NonZeroScalar, PublicKey, SecretKey};

/// Derive the compressed secp256k1 public key (33 bytes) from a 32-byte
/// secret key.
///
/// Returns an error if the secret key is zero or >= curve order. (HMAC-SHA512
/// outputs are uniformly random; the probability of either failure mode is
/// negligible — but we surface the error rather than silently producing an
/// invalid key.)
pub fn public_key_from_secret_key(secret_key: &[u8; 32]) -> Result<[u8; 33], String> {
    let scalar = NonZeroScalar::try_from(secret_key.as_slice())
        .map_err(|e| format!("invalid secp256k1 secret key: {e}"))?;
    let secret = SecretKey::from(scalar);
    let public = PublicKey::from_secret_scalar(&secret.to_nonzero_scalar());

    let encoded = public.to_encoded_point(/* compress */ true);
    let bytes = encoded.as_bytes();
    if bytes.len() != 33 {
        return Err(format!("unexpected encoded pubkey length: {}", bytes.len()));
    }

    let mut out = [0u8; 33];
    out.copy_from_slice(bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// First 32 bytes of HMAC-SHA512(b"IamVoldemort", 16 zero bytes).
    /// See `seed::tests` for the derivation chain.
    const ZERO_ENTROPY_SECRET_KEY: &str =
        "4303f9023f1b99adccf55bbb3ab0e3dc05b8952a97b13e5c21b37fe76b51050e";

    /// Compressed secp256k1 pubkey for the secret above. Independently
    /// computed via Node's `crypto` module — any compliant secp256k1
    /// implementation must produce this value.
    const ZERO_ENTROPY_PUBKEY: &str =
        "039f74228227013bde4ede1307d5899f017cf3f8df2f2dcf12cb065576acbe0c5c";

    #[test]
    fn zero_entropy_pubkey_matches_known_value() {
        let mut sk = [0u8; 32];
        hex::decode_to_slice(ZERO_ENTROPY_SECRET_KEY, &mut sk).unwrap();
        let pk = public_key_from_secret_key(&sk).expect("non-zero scalar");
        assert_eq!(hex::encode(pk), ZERO_ENTROPY_PUBKEY);
    }

    #[test]
    fn zero_secret_key_is_rejected() {
        let sk = [0u8; 32];
        assert!(public_key_from_secret_key(&sk).is_err());
    }

    #[test]
    fn pubkey_first_byte_is_parity_prefix() {
        let mut sk = [0u8; 32];
        hex::decode_to_slice(ZERO_ENTROPY_SECRET_KEY, &mut sk).unwrap();
        let pk = public_key_from_secret_key(&sk).unwrap();
        assert!(pk[0] == 0x02 || pk[0] == 0x03, "compressed pubkey must start with 0x02 or 0x03");
    }
}
