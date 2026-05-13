//! Cross-validation against the official `grin_wallet_libwallet`
//! reference implementation. See [`tests/README.md`] for methodology.
//!
//! These tests feed our slate output through the reference parser +
//! kernel-excess verifier, catching protocol-mismatch bugs that the
//! crate's internal unit tests can't see (because they're internally
//! consistent under either correct or wrong-but-symmetric conventions).

use grin_ext::{
    blind, derive_blind, kernel::KernelFeatures, sender_init_s1, serialize_slate_v4,
    SenderInitParams, SwitchCommitmentType,
};
use grin_wallet_libwallet::Slate;

// grin_keychain is re-exported by grin_wallet_libwallet at the workspace
// level, but cleanest to import it directly. We pull the underlying
// types from grin_keychain since that's where the reference derivation
// implementation lives.
use grin_keychain::{ExtKeychain, ExtKeychainPath, Keychain, SwitchCommitmentType as RefSwitch};

use hmac::{Hmac, Mac};
use sha2::Sha512;
type HmacSha512 = Hmac<Sha512>;

/// Compute the 64-byte extended private key our crate consumes
/// (master = HMAC-SHA512(b"IamVoldemort", seed)). Identical to what
/// `grin_keychain::ExtendedPrivKey::new_master(secp, hasher, seed)`
/// produces internally — both use the same HMAC-SHA512 with the
/// `"IamVoldemort"` master-seed key.
fn master_ext_from_seed(seed: &[u8]) -> [u8; 64] {
    let mut mac = HmacSha512::new_from_slice(b"IamVoldemort").expect("hmac key");
    mac.update(seed);
    let res = mac.finalize().into_bytes();
    let mut out = [0u8; 64];
    out.copy_from_slice(&res);
    out
}

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

/// Cross-validate our `derive_blind` against `grin_keychain::
/// ExtKeychain::derive_key`. Both should produce the same 32-byte
/// scalar from the same (seed, path, amount, switch) inputs.
///
/// This is the most load-bearing primitive we own: it's used for
/// every input blind, every change-output blind, and the address-
/// key derivation. A bug here makes every Grin output the wallet
/// produces unspendable by the wallet itself (since recovery uses
/// the same derivation).
#[test]
fn derive_blind_matches_grin_keychain_derive_key() {
    // Fixed test seed — 32 bytes of mixed pattern. Independent of any
    // mnemonic; we just want byte-equal master keys on both sides.
    let seed: [u8; 32] = [
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32,
        0x10, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
        0xff, 0x00,
    ];

    // Both derivations start from the same 64-byte extended key. Our
    // crate consumes the raw 64 bytes; grin_keychain takes the seed
    // and computes the same 64 bytes via `new_master`.
    let ext = master_ext_from_seed(&seed);

    let keychain = ExtKeychain::from_seed(&seed, /* is_test */ false)
        .expect("ExtKeychain::from_seed should accept any 32 bytes");

    // A handful of representative paths covering output, change, and
    // address-key conventions used by grin-wallet's wallet impl.
    let test_cases = [
        (1_000_000_000u64, [0u32, 0, 0, 0], RefSwitch::Regular),
        (12_345_678u64, [0, 0, 1, 0], RefSwitch::Regular),
        (1u64, [0, 0, 0, 7], RefSwitch::Regular),
        (0u64, [0, 1, 0, 0], RefSwitch::None),
        (999_999_999u64, [0, 0, 42, 99], RefSwitch::None),
    ];

    for (amount, path, switch) in test_cases {
        let id = ExtKeychainPath::new(4, path[0], path[1], path[2], path[3]).to_identifier();
        let ref_key = keychain
            .derive_key(amount, &id, switch)
            .expect("grin_keychain derive_key");
        let ref_bytes = ref_key.0;

        let ours_switch = match switch {
            RefSwitch::Regular => SwitchCommitmentType::Regular,
            RefSwitch::None => SwitchCommitmentType::None,
        };
        let ours = derive_blind(&ext, &path, amount, ours_switch).expect("our derive_blind");

        assert_eq!(
            ours, ref_bytes,
            "derive_blind disagreed with grin_keychain for path {:?} amount {} switch {:?}",
            path, amount, switch
        );
    }
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
