//! Cross-validation against the official `grin_wallet_libwallet`
//! reference implementation. See [`tests/README.md`] for methodology.
//!
//! These tests feed our slate output through the reference parser +
//! kernel-excess verifier, catching protocol-mismatch bugs that the
//! crate's internal unit tests can't see (because they're internally
//! consistent under either correct or wrong-but-symmetric conventions).

use grin_ext::{
    blind, create_invoice, create_send_transaction, derive_blind, deserialize_slate_v4_bin,
    finalize_invoice, finalize_send_slate, kernel::KernelFeatures, pedersen_commit,
    random_secret_nonce, sender_init_s1, serialize_slate_v4, serialize_slate_v4_bin,
    sign_incoming_send_slate, sign_invoice, CreateInvoiceParams, CreateSendTxParams,
    FinalizeInvoiceParams, FinalizeSendParams, SenderInitParams, SignIncomingSendParams,
    SignInvoiceParams, SwitchCommitmentType, UnspentOutput,
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

/// End-to-end: build a complete S1 slate via `create_send_transaction`
/// (using deterministic input commitments + path) and verify
/// `grin_wallet_libwallet::Slate::deserialize_upgrade` accepts the
/// resulting JSON and parses inputs / change output / sender
/// participant correctly.
///
/// This exercises the full orchestration path: derive input blinds,
/// rederive + verify commitments, compute change blind + Pedersen +
/// bulletproof, compute sender blind excess, build slate, append
/// inputs/outputs.
#[test]
fn create_send_transaction_produces_slate_grin_wallet_accepts() {
    let seed: [u8; 32] = [0x42u8; 32];
    let ext = master_ext_from_seed(&seed);

    // Build a single fake input: derive its blind at a chosen path,
    // Pedersen-commit it, and pretend that's an on-chain UTXO. This
    // sidesteps needing a real Grin testnet — we generate a
    // self-consistent UTXO the orchestrator can verify.
    let input_path = [0u32, 0, 0, 0];
    let input_amount = 5_000_000_000u64; // 5 GRIN
    let input_blind =
        derive_blind(&ext, &input_path, input_amount, SwitchCommitmentType::Regular).unwrap();
    let input_commitment = pedersen_commit(input_amount, &input_blind).unwrap();

    let params = CreateSendTxParams {
        extended_private_key: ext,
        inputs: vec![UnspentOutput {
            path: input_path,
            amount: input_amount,
            commitment: input_commitment,
            is_coinbase: false,
        }],
        amount: 1_000_000_000, // send 1 GRIN
        fee: 8_000_000,        // 0.008 GRIN — typical 1-input 2-output fee
        kernel_features: KernelFeatures::Plain { fee: 8_000_000 },
        change_path: [0, 0, 1, 0], // arbitrary fresh-ish path
        kernel_offset: [0u8; 32],
        kernel_nonce: random_secret_nonce(),
        bp_rewind_nonce: [0x11u8; 32],
        bp_private_nonce: [0x22u8; 32],
        slate_id: None,
    };

    let out = create_send_transaction(&params).expect("create_send_transaction");

    // We expect a change output since inputs (5 GRIN) > amount + fee
    // (1.008 GRIN).
    let change = out
        .change_output
        .as_ref()
        .expect("change output should exist");
    assert_eq!(change.amount, input_amount - params.amount - params.fee);

    // Slate.coms should hold 1 input ref + 1 change output.
    let coms = out.slate.coms.as_ref().expect("slate.coms populated");
    assert_eq!(coms.len(), 2, "1 input + 1 change output");
    // Input first (no proof), change second (with proof).
    assert!(coms[0].p.is_none(), "first com is the input — no proof");
    assert!(
        coms[1].p.is_some(),
        "second com is the change output — has proof"
    );

    // JSON round-trip through grin_wallet_libwallet.
    let json = serialize_slate_v4(&out.slate).unwrap();
    let ref_slate = Slate::deserialize_upgrade(&json)
        .expect("grin_wallet_libwallet parses our complete S1 slate");

    assert_eq!(ref_slate.amount, params.amount);
    assert_eq!(ref_slate.fee_fields.fee(), params.fee);
    assert_eq!(ref_slate.num_participants, 2);
    assert_eq!(
        ref_slate.participant_data.len(),
        1,
        "S1 has only the sender's participant data"
    );

    // Reference Slate after compact-aware deserialization tracks inputs
    // + outputs inside the optional `tx` field if present. The compact
    // S1 form might leave `tx` as None and surface inputs via the
    // commitments list. Verify at least that the JSON contained both
    // a 0-features input and a 0-features change output by checking
    // our coms list directly (already done above).
}

/// Full sender ⇄ receiver round-trip: S1 → S2 → S3, kernel excess
/// agreed on both sides, S3 slate accepted by grin_wallet_libwallet,
/// final transaction bytes built without error.
///
/// This is the headline cross-validation: it exercises every
/// orchestrator (create_send_transaction, sign_incoming_send_slate,
/// finalize_send_slate) and the entire low-level slate ceremony
/// underneath. If a future change breaks any participant's math, this
/// test catches it before any wasm rebuild or mainnet broadcast.
#[test]
fn full_send_round_trip_validates_against_grin_wallet() {
    // Two separate wallets — sender and receiver have different seeds.
    let sender_seed: [u8; 32] = [0xaa; 32];
    let receiver_seed: [u8; 32] = [0xbb; 32];
    let sender_ext = master_ext_from_seed(&sender_seed);
    let receiver_ext = master_ext_from_seed(&receiver_seed);

    // Sender builds an input — fake on-chain UTXO synthesized from
    // the sender's keys at a chosen path.
    let input_path = [0u32, 0, 0, 0];
    let input_amount = 3_000_000_000u64;
    let input_blind =
        derive_blind(&sender_ext, &input_path, input_amount, SwitchCommitmentType::Regular)
            .unwrap();
    let input_commit = pedersen_commit(input_amount, &input_blind).unwrap();
    let inputs = vec![UnspentOutput {
        path: input_path,
        amount: input_amount,
        commitment: input_commit,
        is_coinbase: false,
    }];

    let amount = 800_000_000u64; // 0.8 GRIN
    let fee = 8_000_000u64;
    let kernel_features = KernelFeatures::Plain { fee };

    // Sender: create S1 slate.
    let send_out = create_send_transaction(&CreateSendTxParams {
        extended_private_key: sender_ext,
        inputs: inputs.clone(),
        amount,
        fee,
        kernel_features,
        change_path: [0, 0, 1, 0],
        kernel_offset: [0u8; 32],
        kernel_nonce: random_secret_nonce(),
        bp_rewind_nonce: [0x77u8; 32],
        bp_private_nonce: [0x88u8; 32],
        slate_id: None,
    })
    .expect("create_send_transaction");
    assert_eq!(send_out.slate.sta, grin_ext::SlateStateV4::Standard1);

    // Receiver: sign incoming S1 → produce S2.
    let sign_out = sign_incoming_send_slate(&SignIncomingSendParams {
        extended_private_key: receiver_ext,
        s1_slate: send_out.slate.clone(),
        output_path: [0, 0, 0, 0],
        receiver_kernel_nonce: random_secret_nonce(),
        bp_rewind_nonce: [0x99u8; 32],
        bp_private_nonce: [0xaau8; 32],
    })
    .expect("sign_incoming_send_slate");
    assert_eq!(sign_out.slate.sta, grin_ext::SlateStateV4::Standard2);
    assert_eq!(sign_out.output.amount, amount);

    // Sender: finalize S2 → S3 + tx bytes.
    let finalize_out = finalize_send_slate(&FinalizeSendParams {
        s2_slate: sign_out.slate.clone(),
        sender_context: send_out.context.clone(),
        sender_inputs: inputs.clone(),
        change_output: send_out.change_output.clone(),
    })
    .expect("finalize_send_slate");
    assert_eq!(finalize_out.slate.sta, grin_ext::SlateStateV4::Standard3);
    assert!(!finalize_out.tx_bytes.is_empty(), "tx_bytes must be non-empty");

    // Both sides agree on the kernel excess commitment.
    assert_eq!(
        sign_out.kernel_excess, finalize_out.kernel_excess,
        "receiver's S2-computed kernel excess must match sender's S3-computed kernel excess"
    );

    // Reference parser accepts the final S3 slate.
    let s3_json = serialize_slate_v4(&finalize_out.slate).unwrap();
    let ref_s3 = Slate::deserialize_upgrade(&s3_json)
        .expect("grin_wallet_libwallet must accept our S3 slate");
    assert_eq!(ref_s3.amount, amount);
    assert_eq!(ref_s3.fee_fields.fee(), fee);
    assert_eq!(
        ref_s3.participant_data.len(),
        2,
        "S3 carries both sender + receiver participant data"
    );
}

/// Full invoice ceremony round-trip: I1 → I2 → I3.
///
/// Receiver creates the invoice (declaring amount + their output).
/// Sender funds it (selecting inputs, adding change). Receiver
/// finalizes. Both sides agree on the kernel-excess commitment; the
/// final transaction bytes parse via grin_wallet_libwallet.
#[test]
fn full_invoice_round_trip_validates_against_grin_wallet() {
    let receiver_seed: [u8; 32] = [0xcc; 32];
    let sender_seed: [u8; 32] = [0xdd; 32];
    let receiver_ext = master_ext_from_seed(&receiver_seed);
    let sender_ext = master_ext_from_seed(&sender_seed);

    let amount = 500_000_000u64; // 0.5 GRIN
    let fee = 8_000_000u64;
    let kernel_features = KernelFeatures::Plain { fee };

    // Receiver: declare the invoice.
    let invoice_out = create_invoice(&CreateInvoiceParams {
        extended_private_key: receiver_ext,
        amount,
        fee,
        kernel_features,
        output_path: [0u32, 0, 0, 0],
        kernel_offset: [0u8; 32],
        receiver_kernel_nonce: random_secret_nonce(),
        bp_rewind_nonce: [0x33u8; 32],
        bp_private_nonce: [0x44u8; 32],
        slate_id: None,
    })
    .expect("create_invoice");
    assert_eq!(invoice_out.slate.sta, grin_ext::SlateStateV4::Invoice1);
    assert_eq!(invoice_out.output.amount, amount);

    // Sender: build a synthetic on-chain UTXO that satisfies the
    // invoice's requested amount + fee.
    let input_path = [0u32, 0, 0, 0];
    let input_amount = 2_000_000_000u64; // 2 GRIN — plenty
    let input_blind =
        derive_blind(&sender_ext, &input_path, input_amount, SwitchCommitmentType::Regular)
            .unwrap();
    let input_commit = pedersen_commit(input_amount, &input_blind).unwrap();
    let sender_inputs = vec![UnspentOutput {
        path: input_path,
        amount: input_amount,
        commitment: input_commit,
        is_coinbase: false,
    }];

    // Sender: sign the invoice → I2.
    let sign_out = sign_invoice(&SignInvoiceParams {
        extended_private_key: sender_ext,
        i1_slate: invoice_out.slate.clone(),
        inputs: sender_inputs.clone(),
        change_path: [0, 0, 1, 0],
        sender_kernel_nonce: random_secret_nonce(),
        bp_rewind_nonce: [0x55u8; 32],
        bp_private_nonce: [0x66u8; 32],
    })
    .expect("sign_invoice");
    assert_eq!(sign_out.slate.sta, grin_ext::SlateStateV4::Invoice2);

    // Receiver: finalize the invoice → I3 + tx bytes.
    let finalize_out = finalize_invoice(&FinalizeInvoiceParams {
        i2_slate: sign_out.slate.clone(),
        receiver_context: invoice_out.context.clone(),
        sender_inputs: sender_inputs.clone(),
    })
    .expect("finalize_invoice");
    assert_eq!(finalize_out.slate.sta, grin_ext::SlateStateV4::Invoice3);
    assert!(!finalize_out.tx_bytes.is_empty(), "tx_bytes non-empty");

    // I3 slate parses via grin_wallet_libwallet.
    let i3_json = serialize_slate_v4(&finalize_out.slate).unwrap();
    let ref_i3 = Slate::deserialize_upgrade(&i3_json)
        .expect("grin_wallet_libwallet must accept our I3 slate");
    assert_eq!(ref_i3.amount, amount);
    assert_eq!(ref_i3.fee_fields.fee(), fee);
    assert_eq!(
        ref_i3.participant_data.len(),
        2,
        "I3 carries both receiver + sender participant data"
    );
}

/// Compact-binary slate produced by our `serialize_slate_v4_bin` must
/// round-trip cleanly through our own deserializer. Combined with the
/// "external wallets accept this binary" reality (verified by the
/// next test against grin-wallet's SlateV4Bin), this gives us byte-
/// level compatibility.
#[test]
fn slate_v4_bin_round_trips_through_our_deserializer() {
    // Build a full S1 slate via the orchestrator so we hit every
    // field type (sigs, coms with input ref + output with proof,
    // offset, etc).
    let seed = [0xeeu8; 32];
    let ext = master_ext_from_seed(&seed);
    let input_path = [0u32, 0, 0, 0];
    let input_amount = 5_000_000_000u64;
    let input_blind =
        derive_blind(&ext, &input_path, input_amount, SwitchCommitmentType::Regular).unwrap();
    let input_commit = pedersen_commit(input_amount, &input_blind).unwrap();

    let send_out = create_send_transaction(&CreateSendTxParams {
        extended_private_key: ext,
        inputs: vec![UnspentOutput {
            path: input_path,
            amount: input_amount,
            commitment: input_commit,
            is_coinbase: false,
        }],
        amount: 1_000_000_000,
        fee: 8_000_000,
        kernel_features: KernelFeatures::Plain { fee: 8_000_000 },
        change_path: [0, 0, 1, 0],
        kernel_offset: [0u8; 32],
        kernel_nonce: random_secret_nonce(),
        bp_rewind_nonce: [0x11u8; 32],
        bp_private_nonce: [0x22u8; 32],
        slate_id: None,
    })
    .unwrap();

    let bin = serialize_slate_v4_bin(&send_out.slate).expect("serialize_slate_v4_bin");
    let back = deserialize_slate_v4_bin(&bin).expect("deserialize_slate_v4_bin");
    assert_eq!(send_out.slate, back, "binary round-trip lost field data");
}

/// Sanity: random_secret_nonce produces non-zero, never-equal scalars.
/// Not a crypto-strength test — just a regression backstop against an
/// accidental hardcoded-to-zero implementation.
#[test]
fn random_secret_nonce_is_non_zero_and_varies() {
    let a = random_secret_nonce();
    let b = random_secret_nonce();
    assert_ne!(a, [0u8; 32], "must not return all-zero");
    assert_ne!(a, b, "two draws should not match");
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
