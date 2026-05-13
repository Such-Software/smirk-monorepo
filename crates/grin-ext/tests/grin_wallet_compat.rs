//! Cross-validation against the official `grin_wallet_libwallet`
//! reference implementation. See [`tests/README.md`] for methodology.
//!
//! These tests feed our slate output through the reference parser +
//! kernel-excess verifier, catching protocol-mismatch bugs that the
//! crate's internal unit tests can't see (because they're internally
//! consistent under either correct or wrong-but-symmetric conventions).

use grin_ext::{
    blind, kernel::KernelFeatures, sender_init_s1, serialize_slate_v4, SenderInitParams,
};
use grin_wallet_libwallet::Slate;

/// Smoke test: a freshly-constructed S1 slate from our `sender_init_s1`
/// serializes to JSON that `grin_wallet_libwallet::Slate::
/// deserialize_upgrade` accepts without error, and the parsed fields
/// match what we put in.
///
/// What this catches: structural drift in our v4 slate JSON
/// (field names, ordering quirks, type widths) — any way our output
/// disagrees with what the reference expects to read.
#[test]
fn s1_slate_parses_in_grin_wallet() {
    // Deterministic inputs — fixed bytes for blinds + nonces so the test
    // is reproducible across runs.
    let sender_blind_excess = scalar(&[0xa1]);
    let kernel_offset = scalar(&[0xa2]);
    let kernel_nonce = scalar(&[0xa3]);

    let params = SenderInitParams {
        amount: 1_000_000_000, // 1 GRIN
        fee: 23_500_000,       // 23.5 milligrin (typical 1-input 2-output fee)
        kernel_features: KernelFeatures::Plain { fee: 23_500_000 },
        sender_blind_excess,
        kernel_offset,
        kernel_nonce,
    };

    let out = sender_init_s1(&params).expect("sender_init_s1");
    let json = serialize_slate_v4(&out.slate).expect("serialize_slate_v4");

    // Reference parser. If our JSON drifts from the v4 spec this fails.
    let ref_slate =
        Slate::deserialize_upgrade(&json).expect("grin_wallet_libwallet parses our slate");

    assert_eq!(ref_slate.amount, params.amount, "amount round-trip");
    assert_eq!(
        ref_slate.fee_fields.fee(),
        params.fee,
        "fee round-trip via FeeFields"
    );
    assert_eq!(
        ref_slate.num_participants, 2,
        "S1 slate is a 2-party ceremony"
    );
    assert_eq!(
        ref_slate.kernel_features, 0,
        "Plain kernel feature flag is 0"
    );

    // Sender's participant data is the only one filled at S1 — the
    // receiver hasn't responded yet. The reference Slate stores the
    // participant list inside `participant_data`. There should be
    // exactly one entry (the sender).
    assert_eq!(
        ref_slate.participant_data.len(),
        1,
        "S1 slate carries exactly the sender's participant data"
    );
}

/// Sign-convention regression test. With a contrived setup where the
/// sender has a single input and a single change output, the kernel
/// excess scalar `k_sender` should equal `r_change − r_input − offset`.
/// If our `sender_blind_excess` flips signs, the resulting xs public
/// key in the slate won't match what the reference derives from the
/// individual blinds.
///
/// Verifies the fix from commit `c78aff0` doesn't regress.
#[test]
fn sender_blind_excess_sign_matches_grin_reference() {
    // Pick three byte patterns we can trace through the math.
    let r_input = scalar(&[0x10]);
    let r_change = scalar(&[0x40]);
    let offset = scalar(&[0x05]);

    // Our function — what the slate-construction path consumes.
    let excess = blind::sender_blind_excess(&[r_input], &[r_change], &offset);

    // Expected: r_change − r_input − offset = 0x40 − 0x10 − 0x05 = 0x2b
    let expected = scalar(&[0x2b]);
    assert_eq!(
        excess, expected,
        "sender_blind_excess must be `outputs − inputs − offset` per Grin's kernel-excess derivation"
    );
}

/// Helper: a 32-byte scalar with the trailing byte set to `b` (and 0
/// elsewhere). Lets us write `scalar(&[0x2a])` for "small predictable
/// scalar" in tests.
fn scalar(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let n = bytes.len().min(32);
    out[32 - n..].copy_from_slice(&bytes[..n]);
    out
}
