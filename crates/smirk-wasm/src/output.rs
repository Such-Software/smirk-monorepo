//! Output derivation for transaction construction.
//!
//! This module computes the key_offset and commitment mask needed to spend
//! outputs, using the view key and transaction public key from LWS data.

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

/// Derives the key offset for spending an output.
///
/// key_offset = shared_secret (for standard addresses)
/// For subaddresses, additional offset would be added.
pub fn derive_key_offset(
    view_key: &[u8; 32],
    tx_pub_key: &[u8; 32],
    output_index: usize,
) -> Result<Scalar, &'static str> {
    derive_shared_secret(view_key, tx_pub_key, output_index)
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

    #[test]
    fn test_derive_shared_secret() {
        // This is a basic sanity test - actual test vectors would be useful
        let view_key = [1u8; 32]; // Not a valid key, just for testing
        let tx_pub_key = [2u8; 32];

        // This will fail because these aren't valid keys
        let result = derive_shared_secret(&view_key, &tx_pub_key, 0);
        assert!(result.is_err()); // Expected to fail with invalid keys
    }
}
