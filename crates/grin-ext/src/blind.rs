//! Blinding-factor scalar arithmetic over secp256k1.
//!
//! Grin transactions hide values behind Pedersen commitments
//! `C = v·H + r·G` where `r` is the blinding factor (a secp256k1 scalar).
//! Slate construction needs to add and subtract these scalars modulo the
//! curve order `n` to compute things like the kernel "blind excess":
//!
//! ```text
//!   blind_excess = Σ output_blinds − Σ input_blinds − kernel_offset
//! ```
//!
//! These helpers do that arithmetic, reusing the `k256` crate that the rest
//! of the secp256k1 work (Schnorr, BIP32) already depends on.

use k256::elliptic_curve::scalar::FromUintUnchecked;
use k256::{Scalar, U256};

/// Convert raw 32 bytes to a secp256k1 scalar.
///
/// Unlike `secret-key`-style parsing that rejects zero, this accepts any
/// 32 bytes and reduces them modulo the curve order. That's what slate
/// construction needs — sums of valid blinds may legitimately produce zero
/// or values >= n that must reduce.
fn scalar_from_bytes_reduced(bytes: &[u8; 32]) -> Scalar {
    Scalar::from_uint_unchecked(U256::from_be_slice(bytes))
}

/// Sum N 32-byte scalars modulo the secp256k1 curve order.
pub fn sum(scalars: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = Scalar::ZERO;
    for s in scalars {
        acc += scalar_from_bytes_reduced(s);
    }
    acc.to_bytes().into()
}

/// Compute `a + b` modulo the curve order.
pub fn add(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let result = scalar_from_bytes_reduced(a) + scalar_from_bytes_reduced(b);
    result.to_bytes().into()
}

/// Compute `a - b` modulo the curve order.
pub fn sub(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let result = scalar_from_bytes_reduced(a) - scalar_from_bytes_reduced(b);
    result.to_bytes().into()
}

/// Compute the sender-side blind excess for a Grin transaction:
///
/// ```text
///   excess = Σ input_blinds − Σ output_blinds − kernel_offset
/// ```
///
/// (Sign convention: the result, multiplied by G, equals the kernel excess
/// public key contribution from the sender. The full kernel excess will
/// also include the receiver's output blinding factor.)
///
/// Returns 32 bytes ready to use as a secret scalar.
pub fn sender_blind_excess(
    input_blinds: &[[u8; 32]],
    sender_output_blinds: &[[u8; 32]],
    kernel_offset: &[u8; 32],
) -> [u8; 32] {
    let inputs_sum = sum(input_blinds);
    let outputs_sum = sum(sender_output_blinds);
    // excess = inputs - outputs - offset
    sub(&sub(&inputs_sum, &outputs_sum), kernel_offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(b: u8) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[31] = b;
        out
    }

    #[test]
    fn sum_of_empty_is_zero() {
        assert_eq!(sum(&[]), [0u8; 32]);
    }

    #[test]
    fn sum_is_commutative_and_associative() {
        let a = s(1);
        let b = s(2);
        let c = s(3);
        assert_eq!(sum(&[a, b, c]), sum(&[c, b, a]));
        assert_eq!(sum(&[a, b, c]), add(&a, &add(&b, &c)));
    }

    #[test]
    fn add_then_sub_round_trips() {
        let a = s(7);
        let b = s(3);
        let r = add(&a, &b);
        assert_eq!(sub(&r, &b), a);
    }

    #[test]
    fn sub_self_is_zero() {
        let a = s(42);
        assert_eq!(sub(&a, &a), [0u8; 32]);
    }

    #[test]
    fn sender_blind_excess_zero_excess_when_balanced() {
        // Two inputs sum to 5 + 3 = 8. Two outputs sum to 6 + 2 = 8. Offset 0.
        // Excess should be 0 (exactly balanced).
        let inputs = vec![s(5), s(3)];
        let outputs = vec![s(6), s(2)];
        let offset = [0u8; 32];
        let excess = sender_blind_excess(&inputs, &outputs, &offset);
        assert_eq!(excess, [0u8; 32]);
    }

    #[test]
    fn sender_blind_excess_subtracts_offset() {
        let inputs = vec![s(10)];
        let outputs = vec![s(0)];
        let offset = s(3);
        // excess = 10 - 0 - 3 = 7
        let expected = s(7);
        assert_eq!(sender_blind_excess(&inputs, &outputs, &offset), expected);
    }

    #[test]
    fn add_with_carry_into_high_bytes() {
        // 1 << 8  = 256, encoded with byte 30 = 1, byte 31 = 0
        let a = {
            let mut x = [0u8; 32];
            x[30] = 1;
            x
        };
        let b = {
            let mut x = [0u8; 32];
            x[31] = 1;
            x
        };
        let r = add(&a, &b);
        let mut expected = [0u8; 32];
        expected[30] = 1;
        expected[31] = 1;
        assert_eq!(r, expected);
    }
}
