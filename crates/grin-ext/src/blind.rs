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
///   excess_sender = Σ sender_output_blinds − Σ input_blinds − kernel_offset
/// ```
///
/// Sign convention rationale: the full kernel excess scalar `k` is
/// `Σ all_output_blinds − Σ all_input_blinds − offset`. Splitting across
/// participants, the receiver contributes their output blind `r_receiver`
/// and the sender contributes `r_change − r_input − offset`. The sender's
/// contribution multiplied by G IS the sender's `xs` public key in the
/// slate participant data; aggregating `xs_sender + xs_receiver` must
/// equal the kernel excess public key for kernel verification to pass.
///
/// Pre-2026-05-13: this function returned `inputs − outputs − offset`,
/// the negation of the correct value. Sign was undetected because the
/// only non-balanced test happened to flip its own labels. Caught by
/// preparing to build the Grin send-handler on top of the function.
///
/// Returns 32 bytes ready to use as a secret scalar.
pub fn sender_blind_excess(
    input_blinds: &[[u8; 32]],
    sender_output_blinds: &[[u8; 32]],
    kernel_offset: &[u8; 32],
) -> [u8; 32] {
    let inputs_sum = sum(input_blinds);
    let outputs_sum = sum(sender_output_blinds);
    // excess = outputs - inputs - offset
    sub(&sub(&outputs_sum, &inputs_sum), kernel_offset)
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
    fn sender_blind_excess_uses_outputs_minus_inputs() {
        // The convention is `outputs - inputs - offset`. With outputs=10,
        // inputs=0, offset=3 the result is 10 - 0 - 3 = 7. Pre-2026-05-13
        // the implementation returned `inputs - outputs - offset` which
        // would produce the curve-order-mod negation; this test fixes the
        // convention so the value at index 31 reads as expected.
        let inputs = vec![s(0)];
        let outputs = vec![s(10)];
        let offset = s(3);
        let expected = s(7);
        assert_eq!(sender_blind_excess(&inputs, &outputs, &offset), expected);
    }

    #[test]
    fn sender_blind_excess_inputs_minus_outputs_negative_wraps() {
        // outputs=5, inputs=10, offset=0 → 5 - 10 - 0 = -5 mod n. Verify
        // the result is the curve-order-modular negation of `s(5)`, i.e.
        // (n - 5) mod n. Sign-flip in the implementation would produce
        // s(5) instead, so this test pinpoints the bug.
        let inputs = vec![s(10)];
        let outputs = vec![s(5)];
        let offset = [0u8; 32];
        let got = sender_blind_excess(&inputs, &outputs, &offset);
        let pos5 = s(5);
        // (n - 5) computed via blind::sub(0, 5)
        let neg5 = sub(&[0u8; 32], &pos5);
        assert_eq!(got, neg5);
        assert_ne!(got, pos5);
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
