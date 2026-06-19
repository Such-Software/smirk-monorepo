//! ACCEPTANCE GATE for seed-only Grin output recovery.
//!
//! These vectors pin grin-ext's `recover_output` to grin's CANONICAL
//! implementation. We build real Pedersen commitments + bulletproofs using
//! grin's OWN crates (`grin_core::libtx::proof::ProofBuilder` /
//! `LegacyProofBuilder`, `grin_keychain::ExtKeychain`) and then assert
//! grin-ext recovers the EXACT value and the EXACT derivation path
//! (Identifier) byte-for-byte.
//!
//! Why this is the gate: the recovery math is correctness-critical. If the
//! blake2b argument order, the compressed-pubkey serialization, or the
//! message parsing is wrong, recovery silently returns nothing (no crash,
//! no error — just a zero balance). Self-generated proofs would be circular
//! (proving our code agrees with itself). These proofs come from grin's
//! reference code, so passing them proves we agree with grin.
//!
//! Native-only: grin's crates link the C libsecp256k1-zkp and don't build
//! for wasm32. Gated behind `cfg(not(target_arch = "wasm32"))`.
#![cfg(not(target_arch = "wasm32"))]

use grin_ext::recovery::{recover_output, RecoveredOutput};

use grin_core::libtx::proof::{
    create as grin_proof_create, LegacyProofBuilder, ProofBuilder,
};
use grin_keychain::{ExtKeychain, Identifier, Keychain, SwitchCommitmentType};

use hmac::{Hmac, Mac};
use sha2::Sha512;
type HmacSha512 = Hmac<Sha512>;

/// Fixed test seed — arbitrary but deterministic. Mirrors what
/// `grin-ext`'s seed module produces from a real mnemonic; here we feed the
/// raw seed bytes directly so both sides share the same master key.
const SEED: [u8; 32] = [
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
    0x0f, 0x1e, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0x87, 0x96, 0xa5, 0xb4, 0xc3, 0xd2, 0xe1, 0xf0,
];

/// A different seed, for the negative test.
const OTHER_SEED: [u8; 32] = [0x99u8; 32];

/// Compute the 64-byte extended private key grin-ext consumes. This is
/// EXACTLY grin's `ExtendedPrivKey::new_master`:
/// `HMAC-SHA512(key = "IamVoldemort", data = seed)` → secret || chain_code.
/// (Confirmed against grin/keychain/src/extkey_bip32.rs `new_master` +
/// `master_seed() == b"IamVoldemort"`.)
fn ext_key_from_seed(seed: &[u8]) -> [u8; 64] {
    let mut mac = HmacSha512::new_from_slice(b"IamVoldemort").expect("hmac key");
    mac.update(seed);
    let res = mac.finalize().into_bytes();
    let mut out = [0u8; 64];
    out.copy_from_slice(&res);
    out
}

/// Extract the 33-byte commitment from a grin keychain commit.
fn commit_bytes(keychain: &ExtKeychain, amount: u64, id: &Identifier, switch: SwitchCommitmentType) -> [u8; 33] {
    let commit = keychain.commit(amount, id, switch).expect("commit");
    commit.0
}

/// Run grin's reference proof creation with the v3 ProofBuilder and return
/// (commitment_bytes, proof_bytes).
fn make_v3_proof(
    keychain: &ExtKeychain,
    amount: u64,
    id: &Identifier,
    switch: SwitchCommitmentType,
) -> ([u8; 33], Vec<u8>) {
    let commit = keychain.commit(amount, id, switch).expect("commit");
    let builder = ProofBuilder::new(keychain);
    let proof = grin_proof_create(keychain, &builder, amount, id, switch, commit, None)
        .expect("grin proof create (v3)");
    (commit.0, proof.proof[..proof.plen].to_vec())
}

/// Run grin's reference proof creation with the LegacyProofBuilder and
/// return (commitment_bytes, proof_bytes). Legacy always uses Regular.
fn make_legacy_proof(
    keychain: &ExtKeychain,
    amount: u64,
    id: &Identifier,
) -> ([u8; 33], Vec<u8>) {
    let switch = SwitchCommitmentType::Regular;
    let commit = keychain.commit(amount, id, switch).expect("commit");
    let builder = LegacyProofBuilder::new(keychain);
    let proof = grin_proof_create(keychain, &builder, amount, id, switch, commit, None)
        .expect("grin proof create (legacy)");
    (commit.0, proof.proof[..proof.plen].to_vec())
}

/// Build the Identifier byte layout (depth + 4×u32 BE) directly so the test
/// can assert grin-ext returns it verbatim. Matches grin's
/// `ExtKeychainPath::to_identifier`.
fn identifier_bytes(depth: u8, d0: u32, d1: u32, d2: u32, d3: u32) -> [u8; 17] {
    let mut id = [0u8; 17];
    id[0] = depth;
    id[1..5].copy_from_slice(&d0.to_be_bytes());
    id[5..9].copy_from_slice(&d1.to_be_bytes());
    id[9..13].copy_from_slice(&d2.to_be_bytes());
    id[13..17].copy_from_slice(&d3.to_be_bytes());
    id
}

/// TIER 1a — depth-3 / Grim (the "Carol" case).
///
/// Build a depth-3 path `[0, 0, n]` with a Carol-like amount, create a REAL
/// v3 rangeproof + commitment with grin's ProofBuilder, then assert
/// recover_output returns the exact value AND the depth=3 path byte-for-byte.
#[test]
fn tier1a_depth3_grim_v3_builder() {
    let keychain = ExtKeychain::from_seed(&SEED, false).expect("keychain");
    let ext = ext_key_from_seed(&SEED);

    let amount: u64 = 12_345_678_900; // 12.3456789 GRIN — Carol-like
    let n_child: u32 = 7;
    let id = ExtKeychain::derive_key_id(3, 0, 0, n_child, 0);
    let switch = SwitchCommitmentType::Regular;

    let (commit, proof) = make_v3_proof(&keychain, amount, &id, switch);

    let recovered: RecoveredOutput = recover_output(&ext, &commit, &proof)
        .expect("recover_output errored")
        .expect("TIER 1a: depth-3 v3 output must be recovered");

    assert_eq!(recovered.value, amount, "recovered value mismatch");

    let expected_id = identifier_bytes(3, 0, 0, n_child, 0);
    assert_eq!(
        recovered.identifier, expected_id,
        "TIER 1a: depth-3 Identifier must match byte-for-byte"
    );
    assert_eq!(recovered.identifier[0], 3, "depth byte must be 3 (Grim)");
    assert_eq!(recovered.path, vec![0, 0, n_child], "depth-3 path = [0,0,n]");
    assert_eq!(recovered.n_child, n_child);

    // The recovered blind must reproduce the commitment.
    let recommit = grin_ext::pedersen_commit(recovered.value, &recovered.blinding_factor).unwrap();
    assert_eq!(recommit, commit, "recovered blind must reproduce commitment");

    eprintln!(
        "TIER 1a OK — value={} identifier={} path={:?}",
        recovered.value,
        hex::encode(recovered.identifier),
        recovered.path
    );
}

/// TIER 1b — depth-4 / Smirk v3.
///
/// Same as 1a but with a depth-4 path via the v3 ProofBuilder. Assert exact
/// value + depth=4 path.
#[test]
fn tier1b_depth4_smirk_v3_builder() {
    let keychain = ExtKeychain::from_seed(&SEED, false).expect("keychain");
    let ext = ext_key_from_seed(&SEED);

    let amount: u64 = 1_000_000_000; // 1 GRIN
    let id = ExtKeychain::derive_key_id(4, 0, 0, 3, 9);
    let switch = SwitchCommitmentType::Regular;

    let (commit, proof) = make_v3_proof(&keychain, amount, &id, switch);

    let recovered = recover_output(&ext, &commit, &proof)
        .expect("recover_output errored")
        .expect("TIER 1b: depth-4 v3 output must be recovered");

    assert_eq!(recovered.value, amount);

    let expected_id = identifier_bytes(4, 0, 0, 3, 9);
    assert_eq!(
        recovered.identifier, expected_id,
        "TIER 1b: depth-4 Identifier must match byte-for-byte"
    );
    assert_eq!(recovered.identifier[0], 4, "depth byte must be 4 (Smirk v3)");
    assert_eq!(recovered.path, vec![0, 0, 3, 9], "depth-4 path = [0,0,3,9]");
    assert_eq!(recovered.n_child, 9);

    let recommit = grin_ext::pedersen_commit(recovered.value, &recovered.blinding_factor).unwrap();
    assert_eq!(recommit, commit);

    eprintln!(
        "TIER 1b OK — value={} identifier={} path={:?}",
        recovered.value,
        hex::encode(recovered.identifier),
        recovered.path
    );
}

/// TIER 1b' — depth-4 with switch = None (the v3 message also encodes the
/// switch type; this guards against assuming Regular).
#[test]
fn tier1b_depth4_switch_none() {
    let keychain = ExtKeychain::from_seed(&SEED, false).expect("keychain");
    let ext = ext_key_from_seed(&SEED);

    let amount: u64 = 500_000_000;
    let id = ExtKeychain::derive_key_id(4, 0, 1, 2, 3);
    let switch = SwitchCommitmentType::None;

    let (commit, proof) = make_v3_proof(&keychain, amount, &id, switch);

    let recovered = recover_output(&ext, &commit, &proof)
        .expect("recover_output errored")
        .expect("depth-4 switch=None output must be recovered");

    assert_eq!(recovered.value, amount);
    assert_eq!(recovered.identifier, identifier_bytes(4, 0, 1, 2, 3));
    assert_eq!(recovered.switch, grin_ext::SwitchCommitmentType::None);

    let recommit = grin_ext::pedersen_commit(recovered.value, &recovered.blinding_factor).unwrap();
    assert_eq!(recommit, commit);
}

/// TIER 1c — legacy builder.
///
/// A vector built with grin's LegacyProofBuilder. Assert the legacy nonce
/// path (legacy_root_hash, not rewind_hash) recovers it, with depth forced
/// to 3 and switch = Regular.
#[test]
fn tier1c_legacy_builder() {
    let keychain = ExtKeychain::from_seed(&SEED, false).expect("keychain");
    let ext = ext_key_from_seed(&SEED);

    let amount: u64 = 9_876_543_210;
    let n_child: u32 = 42;
    let id = ExtKeychain::derive_key_id(3, 0, 0, n_child, 0);

    let (commit, proof) = make_legacy_proof(&keychain, amount, &id);

    let recovered = recover_output(&ext, &commit, &proof)
        .expect("recover_output errored")
        .expect("TIER 1c: legacy output must be recovered via legacy nonce");

    assert_eq!(recovered.value, amount);

    let expected_id = identifier_bytes(3, 0, 0, n_child, 0);
    assert_eq!(
        recovered.identifier, expected_id,
        "TIER 1c: legacy Identifier (forced depth=3) must match byte-for-byte"
    );
    assert_eq!(recovered.identifier[0], 3, "legacy depth forced to 3");
    assert_eq!(recovered.switch, grin_ext::SwitchCommitmentType::Regular);
    assert_eq!(recovered.path, vec![0, 0, n_child]);

    let recommit = grin_ext::pedersen_commit(recovered.value, &recovered.blinding_factor).unwrap();
    assert_eq!(recommit, commit);

    eprintln!(
        "TIER 1c OK (legacy) — value={} identifier={} path={:?}",
        recovered.value,
        hex::encode(recovered.identifier),
        recovered.path
    );
}

/// NEGATIVE — a proof created for a DIFFERENT seed must return None.
///
/// Proves no false positives: the rewind nonce won't match, OR (if it
/// somehow rewinds) the recomputed commitment won't match the on-chain one.
#[test]
fn negative_wrong_seed_returns_none() {
    // Proof made with OTHER_SEED's keychain...
    let other_keychain = ExtKeychain::from_seed(&OTHER_SEED, false).expect("keychain");
    let amount: u64 = 7_000_000_000;
    let id = ExtKeychain::derive_key_id(3, 0, 0, 5, 0);
    let switch = SwitchCommitmentType::Regular;
    let (commit, proof) = make_v3_proof(&other_keychain, amount, &id, switch);

    // ...but recovered with OUR seed's ext key. Must NOT recover.
    let ext = ext_key_from_seed(&SEED);
    let result = recover_output(&ext, &commit, &proof).expect("recover_output errored");
    assert!(
        result.is_none(),
        "NEGATIVE: output from a different seed must not be recovered (got {result:?})"
    );

    // And legacy proof from the other seed must also not recover.
    let (lcommit, lproof) = make_legacy_proof(&other_keychain, amount, &id);
    let lresult = recover_output(&ext, &lcommit, &lproof).expect("recover_output errored");
    assert!(
        lresult.is_none(),
        "NEGATIVE: legacy output from a different seed must not be recovered"
    );
}

/// NEGATIVE 2 — recovery is for the RIGHT commitment only. A proof rewound
/// against a *mismatched* commitment must return None: even though the
/// rewind nonce is derived from the (wrong) commitment, the recomputed
/// commitment from the recovered path won't equal the supplied one.
///
/// (Note: recovery deliberately does NOT validate range-proof soundness —
/// that's `bullet_proof_verify`'s job. Ownership discovery is rewind +
/// commitment-recompute. So we test the discovery boundary, not soundness.)
#[test]
fn negative_mismatched_commitment_returns_none() {
    let keychain = ExtKeychain::from_seed(&SEED, false).expect("keychain");
    let ext = ext_key_from_seed(&SEED);

    let amount: u64 = 2_000_000_000;
    let id = ExtKeychain::derive_key_id(4, 0, 0, 1, 1);
    let switch = SwitchCommitmentType::Regular;
    let (commit, proof) = make_v3_proof(&keychain, amount, &id, switch);

    // Sanity: recovers with the matching commitment.
    assert!(recover_output(&ext, &commit, &proof).unwrap().is_some());

    // A DIFFERENT, valid commitment (different path) supplied alongside this
    // proof must NOT recover: the nonce changes, rewind fails or the
    // recomputed commitment won't equal the supplied one.
    let other_id = ExtKeychain::derive_key_id(4, 0, 0, 2, 2);
    let other_commit = commit_bytes(&keychain, amount, &other_id, switch);
    assert_ne!(other_commit, commit, "test setup: commitments must differ");

    let result =
        recover_output(&ext, &other_commit, &proof).expect("recover_output must not panic");
    assert!(
        result.is_none(),
        "NEGATIVE: proof rewound against a mismatched commitment must not recover (got {result:?})"
    );
}
