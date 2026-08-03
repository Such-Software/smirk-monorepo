//! Output derivation for transaction construction.
//!
//! This module computes the key_offset and commitment mask needed to spend
//! outputs, using the view key and transaction public key from LWS data.
//
// TODO(post-port-review): this module was lifted verbatim from the
// pre-monorepo `smirk-wasm-monero` package; pre-existing clippy noise
// (useless_conversion across `EdwardsPoint::from(_.into())` chains)
// is allowed here so CI passes. Clean up when we revisit XMR/WOW
// signing for the registry-aware send flow.
#![allow(clippy::useless_conversion)]

use monero_oxide::ed25519::{CompressedPoint, Point, Scalar};
use monero_oxide::primitives::keccak256;
use subtle::CtOption;

/// Helper to convert CtOption to Option
fn ct_option_to_option<T>(ct: CtOption<T>) -> Option<T> {
    if bool::from(ct.is_some()) {
        Some(ct.unwrap())
    } else {
        None
    }
}

/// Derives the shared secret for an output.
///
/// shared_secret = Hs(8 * view_key * tx_pub_key || output_index)
///
/// This is used to compute both the key_offset and commitment_mask.
pub fn derive_shared_secret(
    view_key: &[u8; 32],
    tx_pub_key: &[u8; 32],
    output_index: usize,
) -> Result<Scalar, &'static str> {
    // Parse view key as scalar
    let view_dalek = ct_option_to_option(curve25519_dalek::Scalar::from_canonical_bytes(*view_key))
        .ok_or("Invalid view key scalar")?;

    // Parse tx_pub_key as point
    let tx_pub_point = CompressedPoint::from(*tx_pub_key)
        .decompress()
        .ok_or("Invalid tx_pub_key point")?;

    // Compute 8 * view_key * tx_pub_key (cofactor multiplication)
    let ecdh: Point = Point::from(
        curve25519_dalek::EdwardsPoint::from(tx_pub_point.into())
            .mul_by_cofactor()
            * view_dalek,
    );

    // Serialize: compressed point || varint(output_index)
    let mut derivation_data = ecdh.compress().to_bytes().to_vec();

    // Append output_index as varint
    let mut idx = output_index;
    loop {
        let byte = (idx & 0x7f) as u8;
        idx >>= 7;
        if idx == 0 {
            derivation_data.push(byte);
            break;
        } else {
            derivation_data.push(byte | 0x80);
        }
    }

    // Hash to get shared_key: Hs(derivation || output_index)
    Ok(Scalar::hash(&derivation_data))
}

/// Derives the subaddress spend secret `m` for `(major, minor)`.
///
/// `m = Hs("SubAddr\0"(8) || view_key(32) || major_LE(4) || minor_LE(4))`
///
/// `Hs` is `keccak256` reduced mod `l` (`Scalar::hash`). This is byte-identical
/// to monero-oxide `ViewPair::subaddress_derivation` (view_pair.rs): that hashes
/// `<[u8;32]>::from(*self.view)`, the canonical little-endian encoding of the
/// private view scalar. Our `view_key` argument is that same canonical encoding
/// (`derive_shared_secret` already requires it to parse via
/// `from_canonical_bytes`), and it matches the address-side derivation in
/// `packages/core/src/address.ts` (`cryptonoteSubaddress`).
///
/// `(0, 0)` is the primary account/index and is NOT a subaddress; callers pass
/// `None`/`Some((0, 0))` for that case and never reach this function.
pub fn subaddress_secret(view_key: &[u8; 32], major: u32, minor: u32) -> Scalar {
    let mut data = Vec::with_capacity(8 + 32 + 4 + 4);
    data.extend_from_slice(b"SubAddr\0");
    data.extend_from_slice(view_key);
    data.extend_from_slice(&major.to_le_bytes());
    data.extend_from_slice(&minor.to_le_bytes());
    Scalar::hash(&data)
}

/// Derives the key offset for spending an output.
///
/// For the primary address (`subaddr_index == None` or `Some((0, 0))`) the key
/// offset is the bare shared secret `Hs(8aR || o)`, byte-identical to the
/// pre-subaddress behavior (regression-preserving).
///
/// For a subaddress `(major, minor)` the one-time key is
/// `P = Hs(8aR || o)·G + D`, where `D = B + m·G` is the subaddress public spend
/// key. The corresponding private one-time key is `Hs(8aR || o) + b + m`, so the
/// spendable key offset (added to the private spend key `b`) is
/// `shared_secret + m`. The caller supplies the correct per-output `tx_pub_key`
/// (for subaddress outputs the sender publishes `R_i = r·D`, and `8aR_i`
/// recovers the same shared secret), so only the additive `m` term is applied
/// here.
pub fn derive_key_offset(
    view_key: &[u8; 32],
    tx_pub_key: &[u8; 32],
    output_index: usize,
    subaddr_index: Option<(u32, u32)>,
) -> Result<Scalar, &'static str> {
    let shared = derive_shared_secret(view_key, tx_pub_key, output_index)?;
    match subaddr_index {
        None | Some((0, 0)) => Ok(shared),
        Some((major, minor)) => {
            let m = subaddress_secret(view_key, major, minor);
            // monero-oxide `Scalar` does not implement `Add`; do the field
            // addition on the dalek scalars and re-wrap (identical pattern to
            // signing.rs's one-time-key math).
            let sum = curve25519_dalek::Scalar::from(shared.into())
                + curve25519_dalek::Scalar::from(m.into());
            Ok(Scalar::from(sum))
        }
    }
}

/// Derives the commitment mask for an output.
///
/// commitment_mask = Hs("commitment_mask" || shared_secret)
pub fn derive_commitment_mask(
    view_key: &[u8; 32],
    tx_pub_key: &[u8; 32],
    output_index: usize,
) -> Result<Scalar, &'static str> {
    let shared_secret = derive_shared_secret(view_key, tx_pub_key, output_index)?;

    // Compute Hs("commitment_mask" || shared_secret)
    let mut mask_data = b"commitment_mask".to_vec();
    mask_data.extend_from_slice(&<[u8; 32]>::from(shared_secret));

    Ok(Scalar::hash(&mask_data))
}

/// Derives the view tag for an output.
///
/// view_tag = first byte of Hs("view_tag" || 8Ra || output_index)
///
/// Currently unused: kept for the eventual XMR view-tag scanning path
/// (Salvium hardfork onward; lets a wallet skip output decryption when
/// the view tag doesn't match before doing the expensive ed25519 ops).
#[allow(dead_code)]
pub fn derive_view_tag(
    view_key: &[u8; 32],
    tx_pub_key: &[u8; 32],
    output_index: usize,
) -> Result<u8, &'static str> {
    // Parse view key as scalar
    let view_dalek = ct_option_to_option(curve25519_dalek::Scalar::from_canonical_bytes(*view_key))
        .ok_or("Invalid view key scalar")?;

    // Parse tx_pub_key as point
    let tx_pub_point = CompressedPoint::from(*tx_pub_key)
        .decompress()
        .ok_or("Invalid tx_pub_key point")?;

    // Compute 8 * view_key * tx_pub_key
    let ecdh: Point = Point::from(
        curve25519_dalek::EdwardsPoint::from(tx_pub_point.into())
            .mul_by_cofactor()
            * view_dalek,
    );

    // Build: "view_tag" || 8Ra || varint(output_index)
    let mut data = b"view_tag".to_vec();
    data.extend_from_slice(&ecdh.compress().to_bytes());

    // Append output_index as varint
    let mut idx = output_index;
    loop {
        let byte = (idx & 0x7f) as u8;
        idx >>= 7;
        if idx == 0 {
            data.push(byte);
            break;
        } else {
            data.push(byte | 0x80);
        }
    }

    Ok(keccak256(&data)[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::Scalar as DScalar;
    use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;

    #[test]
    fn test_derive_shared_secret() {
        // This is a basic sanity test - actual test vectors would be useful
        let view_key = [1u8; 32]; // Not a valid key, just for testing
        let tx_pub_key = [2u8; 32];

        // This will fail because these aren't valid keys
        let result = derive_shared_secret(&view_key, &tx_pub_key, 0);
        assert!(result.is_err()); // Expected to fail with invalid keys
    }

    // ------------------------------------------------------------------------
    // Subaddress-spend money gate (offline-provable): G5/G6/G8
    // ------------------------------------------------------------------------

    /// Build a valid (canonical view scalar, on-curve tx pubkey) fixture.
    fn fixture() -> ([u8; 32], [u8; 32], usize) {
        // from_bytes_mod_order reduces < l, so the bytes are a canonical scalar
        // that derive_shared_secret's from_canonical_bytes will accept.
        let a = DScalar::from_bytes_mod_order([7u8; 32]);
        let view_key = a.to_bytes();
        let r = DScalar::from_bytes_mod_order([9u8; 32]);
        let tx_pub_key = (ED25519_BASEPOINT_POINT * r).compress().to_bytes();
        (view_key, tx_pub_key, 3)
    }

    fn varint(mut idx: usize) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let byte = (idx & 0x7f) as u8;
            idx >>= 7;
            if idx == 0 {
                out.push(byte);
                break;
            }
            out.push(byte | 0x80);
        }
        out
    }

    /// (a) `subaddress_secret(view_key, 0, minor)` is byte-identical to the
    /// canonical address-side derivation
    /// `m = keccak256("SubAddr\0" || a || major_LE || minor_LE) mod l`
    /// (the exact formula proven correct in packages/core/src/address.ts and in
    /// monero-oxide view_pair.rs::subaddress_derivation), and the key offset for
    /// a subaddress equals `shared_secret + m`.
    #[test]
    fn subaddress_secret_matches_canonical_and_is_additive() {
        let (view_key, tx_pub_key, o) = fixture();

        for minor in [1u32, 7, 42, 65535] {
            // Reconstruct m the same way address.ts / view_pair.rs do.
            let mut input = Vec::with_capacity(8 + 32 + 4 + 4);
            input.extend_from_slice(b"SubAddr\0");
            input.extend_from_slice(&view_key);
            input.extend_from_slice(&0u32.to_le_bytes());
            input.extend_from_slice(&minor.to_le_bytes());
            let m_ref = DScalar::from_bytes_mod_order(keccak256(&input));

            assert_eq!(
                <[u8; 32]>::from(subaddress_secret(&view_key, 0, minor)),
                m_ref.to_bytes(),
                "subaddress_secret must equal the canonical Hs('SubAddr\\0'||a||maj||min)"
            );

            // key_offset(Some((0,minor))) == key_offset(None) + m
            let base = derive_key_offset(&view_key, &tx_pub_key, o, None).unwrap();
            let sub = derive_key_offset(&view_key, &tx_pub_key, o, Some((0, minor))).unwrap();
            let expected =
                DScalar::from(base.into()) + DScalar::from(subaddress_secret(&view_key, 0, minor).into());
            assert_eq!(
                sub,
                Scalar::from(expected),
                "subaddress key offset must be shared_secret + m"
            );
            // A real subaddress must not collapse to the primary offset.
            assert_ne!(sub, base);
        }
    }

    /// (b) Regression: `None` and `Some((0,0))` are byte-identical to the
    /// pre-change output (which was exactly `derive_shared_secret`) for a fixed
    /// (view_key, tx_pub_key, output_index). The primary spend path is unchanged.
    #[test]
    fn primary_offset_is_unchanged_regression() {
        let (view_key, tx_pub_key, o) = fixture();

        // The pre-change derive_key_offset body was literally derive_shared_secret.
        let pre_change = derive_shared_secret(&view_key, &tx_pub_key, o).unwrap();

        assert_eq!(
            derive_key_offset(&view_key, &tx_pub_key, o, None).unwrap(),
            pre_change,
            "None must reproduce the pre-subaddress key offset byte-for-byte"
        );
        assert_eq!(
            derive_key_offset(&view_key, &tx_pub_key, o, Some((0, 0))).unwrap(),
            pre_change,
            "Some((0,0)) is the primary index and must equal the pre-change offset"
        );

        // Independently recompute the primary key offset from raw curve
        // primitives (8·a·R || varint(o), keccak-reduce) so this test also pins
        // the primary derivation without depending on derive_shared_secret's body.
        let a = ct_option_to_option(DScalar::from_canonical_bytes(view_key)).unwrap();
        let r_point = CompressedPoint::from(tx_pub_key).decompress().unwrap();
        let eight_ecdh = (curve25519_dalek::EdwardsPoint::from(r_point.into()) * a).mul_by_cofactor();
        let mut deriv = eight_ecdh.compress().to_bytes().to_vec();
        deriv.extend_from_slice(&varint(o));
        assert_eq!(
            derive_key_offset(&view_key, &tx_pub_key, o, None).unwrap(),
            Scalar::hash(&deriv),
            "primary key offset must equal Hs(8aR || varint(o)) from raw primitives"
        );
    }

    /// (c) Independent oracle: check our subaddress math against monero-oxide's
    /// own `ViewPair::subaddress`, not against a hand-retyped copy of the same
    /// formula.
    ///
    /// The previous version of this test rebuilt the `"SubAddr\0" || a || maj ||
    /// min` preimage inline and compared it to our implementation of that same
    /// preimage. Both sides shared one set of literals, so a shared misconception
    /// (wrong domain string, wrong field order, wrong endianness) would have
    /// passed. This version never spells the preimage out: it asks monero-oxide
    /// for the subaddress and only checks the relationship we depend on.
    ///
    /// What is asserted, for each index:
    ///   1. `D == B + m·G`, where `D` is the public spend key of the address
    ///      returned by `ViewPair::subaddress` and `m` is our
    ///      `subaddress_secret`. This is the fact the spend path rests on: the
    ///      private one-time key is `Hs(8aR || o) + b + m`, so a wrong `m` means
    ///      an unspendable output.
    ///   2. End to end, for a synthetic on-chain output paid to that subaddress
    ///      (`R = r·D`, `P = Hs(8aR || o)·G + D`): `(b + derive_key_offset(..))·G
    ///      == P`. That is exactly the check `build_output_with_decoys` runs
    ///      before signing.
    ///   3. The primary path is untouched: `None` and `Some((0, 0))` still equal
    ///      the bare shared secret, byte for byte.
    ///
    /// Remaining live gate: scanning a real subaddress-paying transaction off a
    /// live chain with `monero_wallet::Scanner`.
    #[test]
    fn subaddress_math_matches_monero_oxide_view_pair() {
        use monero_wallet::ViewPair;
        use monero_wallet::address::{Network, SubaddressIndex};
        use zeroize::Zeroizing;

        let (view_key, tx_pub_key, o) = fixture();
        let a = ct_option_to_option(DScalar::from_canonical_bytes(view_key)).unwrap();
        let b = DScalar::from_bytes_mod_order([11u8; 32]);
        let b_point = ED25519_BASEPOINT_POINT * b;

        // monero-oxide's own view pair, built from the same (a, B).
        let view_pair = ViewPair::new(
            Point::from(b_point),
            Zeroizing::new(Scalar::from(a)),
        )
        .expect("B = b·G is torsion free");

        // (3) The primary path is unchanged and does not involve any subaddress term.
        let primary = derive_shared_secret(&view_key, &tx_pub_key, o).unwrap();
        assert_eq!(derive_key_offset(&view_key, &tx_pub_key, o, None).unwrap(), primary);
        assert_eq!(
            derive_key_offset(&view_key, &tx_pub_key, o, Some((0, 0))).unwrap(),
            primary
        );

        for (maj, min) in [(0u32, 1u32), (0, 7), (1, 2), (3, 100)] {
            let index = SubaddressIndex::new(maj, min).expect("non-zero index");
            let oracle_spend = view_pair.subaddress(Network::Mainnet, index).spend();

            // (1) D == B + m·G with our own m.
            let m = DScalar::from(subaddress_secret(&view_key, maj, min).into());
            let ours = b_point + (ED25519_BASEPOINT_POINT * m);
            assert_eq!(
                oracle_spend.compress().to_bytes(),
                ours.compress().to_bytes(),
                "B + m·G must equal monero-oxide's subaddress spend key for ({maj},{min})"
            );

            // (2) End to end on a synthetic output paid to that subaddress.
            let d = curve25519_dalek::EdwardsPoint::from(oracle_spend.into());
            let r = DScalar::from_bytes_mod_order([13u8; 32]);
            let sub_tx_pub_key = (d * r).compress().to_bytes();
            let shared = derive_shared_secret(&view_key, &sub_tx_pub_key, o).unwrap();
            let one_time_public = (ED25519_BASEPOINT_POINT * DScalar::from(shared.into())) + d;

            let key_offset =
                derive_key_offset(&view_key, &sub_tx_pub_key, o, Some((maj, min))).unwrap();
            let recovered = ED25519_BASEPOINT_POINT * (b + DScalar::from(key_offset.into()));
            assert_eq!(
                recovered.compress().to_bytes(),
                one_time_public.compress().to_bytes(),
                "(b + key_offset)·G must control the subaddress output for ({maj},{min})"
            );

            // The primary key offset must NOT control it, or the test proves nothing.
            let wrong = ED25519_BASEPOINT_POINT
                * (b + DScalar::from(
                    derive_key_offset(&view_key, &sub_tx_pub_key, o, None).unwrap().into(),
                ));
            assert_ne!(wrong.compress().to_bytes(), one_time_public.compress().to_bytes());
        }
    }
}
