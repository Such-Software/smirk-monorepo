//! Seed-only output recovery: view-key / bulletproof-rewind.
//!
//! This is the foundation of recovering a wallet's Grin balance from the
//! seed alone (no stored output list). Given an on-chain commitment +
//! range proof, we rewind the proof to recover the committed value *and*
//! the embedded derivation path, then re-derive the commitment from the
//! seed to confirm the output really belongs to this wallet.
//!
//! This is a faithful re-implementation of Grin's canonical scheme in
//! `grin/core/src/libtx/proof.rs`:
//!
//! - [`ProofBuilder`](https://github.com/mimblewimble/grin): the v3 scheme
//!   (used by Smirk v3 outputs and all post-HF2 grin-wallet outputs).
//! - `LegacyProofBuilder`: the pre-HF1 scheme (Grim-era / pre-2026 Smirk
//!   outputs imported into v0.3).
//!
//! ## The scheme (do NOT brute-force child indices)
//!
//! There is **no index to iterate**. Discovery is entirely commitment-keyed:
//!
//! 1. `rewind_hash = blake2b-256(data = compressed_public_root_key (33B),
//!    key = [])`. The public root key is the secp256k1 pubkey of the
//!    wallet's master secret (`ext_key[0..32]`).
//! 2. Per output, `rewind_nonce = blake2b-256(data = rewind_hash (32B),
//!    key = commitment (33B))`. Keyed by the **commitment**, not any path.
//! 3. Rewinding the bulletproof with that nonce yields the value *and* a
//!    20-byte proof message. The derivation path (`Identifier`: depth +
//!    4×u32) is **parsed from** the message, never guessed. So depth-3
//!    (Grim) vs depth-4 (Smirk v3) is irrelevant to discovery.
//! 4. The recovered `(value, path, switch)` is confirmed by recomputing
//!    `pedersen_commit(value, derive_blind(ext, path, value, switch))` and
//!    asserting equality with the on-chain commitment. If it doesn't match,
//!    the output isn't ours (no false positives).
//!
//! ### blake2b argument order (CORRECTNESS-CRITICAL)
//!
//! Grin calls `blake2b(output_size, key, data)` (blake2-rfc's signature).
//! Getting `key` and `data` backwards silently zero-hits (recovers
//! nothing). We mirror it exactly:
//!
//! - `rewind_hash`: `blake2b(32, key = &[], data = public_root_key)`  →
//!   the key is **empty**; the public root key is the **data**. (Same as
//!   `slatepack_address.rs`'s unkeyed `Blake2bVar`.)
//! - `rewind_nonce`: `blake2b(32, key = commitment.0, data = rewind_hash)`
//!   → the **commitment** is the BLAKE2b key; the rewind hash is the data.
//!   We use `Blake2bMac<U32>` (native BLAKE2b keyed mode, NOT HMAC) which
//!   matches blake2-rfc's keyed `blake2b`.
//!
//! Both directions are pinned by the vector test in
//! `tests/grin_recovery_vectors.rs`, which generates real proofs with
//! grin's own `ProofBuilder`/`LegacyProofBuilder` and recovers them here.

use blake2::digest::{consts::U32, FixedOutput, Update, VariableOutput};
use blake2::{Blake2bMac, Blake2bVar};

use crate::bulletproof::{bullet_proof_create_with_message, pedersen_commit, COMMITMENT_LEN};
use crate::keychain::{derive_blind, SwitchCommitmentType};
use crate::secp256k1::public_key_from_secret_key;

/// Length of a Grin output `Identifier` in bytes: `depth (1) || 4×u32 (16)`.
pub const IDENTIFIER_LEN: usize = 17;

/// A recovered output, fully re-derived and confirmed against its on-chain
/// commitment. Returning the raw `identifier` (depth + path) verbatim
/// preserves Grim's depth-3 vs Smirk's depth-4 distinction, which matters
/// when the path is later replayed through `derive_blind` to spend the
/// output (grin's `derive_key` only walks `0..depth`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveredOutput {
    /// The committed value, in nanogrin.
    pub value: u64,
    /// The 17-byte Grin `Identifier`: `[0] = depth`, `[1..17] = 4×u32 BE`.
    pub identifier: [u8; IDENTIFIER_LEN],
    /// Derivation path, `depth` elements long (the prefix of the 4 u32s
    /// that grin's `derive_key` actually walks). Spend with
    /// `derive_blind(ext, &path, value, switch)`.
    pub path: Vec<u32>,
    /// The last path index (a.k.a. `n_child`), or 0 for the root path.
    pub n_child: u32,
    /// Switch commitment type for this output.
    pub switch: SwitchCommitmentType,
    /// The 32-byte blinding factor that re-derives this output's commitment
    /// from the seed (`derive_blind(ext, &path, value, switch)`). This is
    /// the spendable blind: recomputed locally, never recovered from the
    /// proof.
    pub blinding_factor: [u8; 32],
}

/// Compute the wallet's `rewind_hash`:
/// `blake2b-256(data = compressed_public_root_key (33B), key = [])`.
///
/// The public root key is the secp256k1 pubkey of the wallet's master
/// secret, which is the first 32 bytes of the 64-byte extended private key.
/// `key = []` → unkeyed BLAKE2b (matches grin's `blake2b(32, &[], data)`).
pub fn rewind_hash(extended_private_key: &[u8; 64]) -> Result<[u8; 32], String> {
    let mut master_secret = [0u8; 32];
    master_secret.copy_from_slice(&extended_private_key[..32]);
    let public_root_key = public_key_from_secret_key(&master_secret)?;

    // Unkeyed BLAKE2b-256 over the 33-byte compressed public root key.
    let mut hasher = Blake2bVar::new(32).map_err(|e| format!("blake2b init: {e}"))?;
    hasher.update(&public_root_key);
    let mut out = [0u8; 32];
    hasher
        .finalize_variable(&mut out)
        .map_err(|e| format!("blake2b finalize: {e}"))?;
    Ok(out)
}

/// v3 per-output rewind nonce:
/// `blake2b-256(data = rewind_hash (32B), key = commitment (33B))`.
///
/// The commitment is the BLAKE2b *key* (native keyed mode, not HMAC).
pub fn output_rewind_nonce(
    rewind_hash: &[u8; 32],
    commitment: &[u8; COMMITMENT_LEN],
) -> Result<[u8; 32], String> {
    keyed_blake2b_256(commitment, rewind_hash)
}

/// Legacy (pre-HF1) per-output rewind nonce:
/// `blake2b-256(data = legacy_root_hash (32B), key = commitment (33B))`.
///
/// `legacy_root_hash = derive_key(0, root_key_id, Regular)` =
/// `blind_switch(0, master_secret)`, i.e. `derive_blind` with an empty
/// path, amount 0, and the `Regular` switch.
pub fn legacy_output_rewind_nonce(
    legacy_root_hash: &[u8; 32],
    commitment: &[u8; COMMITMENT_LEN],
) -> Result<[u8; 32], String> {
    keyed_blake2b_256(commitment, legacy_root_hash)
}

/// Compute the legacy root hash for an extended private key:
/// `derive_key(0, root_key_id, Regular)` = `blind_switch(0, master_secret)`.
pub fn legacy_root_hash(extended_private_key: &[u8; 64]) -> Result<[u8; 32], String> {
    // Empty path → no BIP32 child derivation; amount 0; Regular switch.
    derive_blind(extended_private_key, &[], 0, SwitchCommitmentType::Regular)
}

/// Native BLAKE2b-256 keyed hash: `blake2b(32, key, data)` (blake2-rfc
/// argument order). Uses `Blake2bMac<U32>` so the key is consumed via
/// BLAKE2b's parameter block (NOT HMAC).
fn keyed_blake2b_256(key: &[u8], data: &[u8]) -> Result<[u8; 32], String> {
    let mut mac = <Blake2bMac<U32>>::new_with_salt_and_personal(key, &[], &[])
        .map_err(|e| format!("blake2b keyed init: {e:?}"))?;
    Update::update(&mut mac, data);
    let out = mac.finalize_fixed();
    let mut res = [0u8; 32];
    res.copy_from_slice(&out);
    Ok(res)
}

/// Rewind a bulletproof, returning the recovered value, the rewind-derived
/// blinding factor, and the embedded 20-byte proof message (+ its length).
///
/// This is like [`crate::bulletproof::bullet_proof_rewind`] but additionally
/// returns `info.message` and `info.mlen`: the proof message carries the
/// derivation path, which the plain rewind wrapper discards.
///
/// Returns `Ok(None)` if the nonce doesn't match the proof (not our output).
pub fn bullet_proof_rewind_with_message(
    commitment: &[u8; COMMITMENT_LEN],
    rewind_nonce: &[u8; 32],
    proof_bytes: &[u8],
) -> Result<Option<(u64, [u8; 32], Vec<u8>, usize)>, String> {
    use secp256k1zkp::pedersen::{Commitment, RangeProof};
    use secp256k1zkp::{ContextFlag, Secp256k1, SecretKey};

    let secp = Secp256k1::with_caps(ContextFlag::Commit);
    let commit = Commitment::from_vec(commitment.to_vec());
    let nonce = SecretKey::from_slice(&secp, rewind_nonce)
        .map_err(|e| format!("invalid rewind nonce: {e:?}"))?;

    if proof_bytes.len() > secp256k1zkp::constants::MAX_PROOF_SIZE {
        return Err(format!("proof too large: {} bytes", proof_bytes.len()));
    }
    let mut proof = RangeProof {
        proof: [0u8; secp256k1zkp::constants::MAX_PROOF_SIZE],
        plen: proof_bytes.len(),
    };
    proof.proof[..proof_bytes.len()].copy_from_slice(proof_bytes);

    match secp.rewind_bullet_proof(commit, nonce, None, proof) {
        Ok(info) => {
            let mut blind_out = [0u8; 32];
            blind_out.copy_from_slice(&info.blinding[..]);
            // info.message is the fixed 20-byte proof message buffer; mlen
            // is reported by the underlying lib (0 in this binding's wrapper,
            // meaning "untruncated": the full message buffer is valid).
            let message = info.message.as_bytes().to_vec();
            Ok(Some((info.value, blind_out, message, info.mlen)))
        }
        Err(_) => Ok(None),
    }
}

/// Build the v3 20-byte proof message that [`check_output`] parses: the
/// inverse of the parser, and the same layout grin's `ProofBuilder` emits
/// (`grin/core/src/libtx/proof.rs::proof_message`):
///
/// ```text
/// [0]    = 0           (reserved)
/// [1]    = 0           (wallet type: standard)
/// [2]    = switch      (None=0, Regular=1)
/// [3]    = depth
/// [4..20]= 4 × u32 BE  (the derivation path)
/// ```
///
/// `path` is the full 4-element path and `depth` is how many elements are
/// meaningful. Smirk outputs use `depth = 4` with `path = [0, 0, n, 0]`, so
/// the spendable child index `n` lives in `path[2]` (NOT `path[depth-1]`).
/// Path elements are big-endian to match the parser (`u32::from_be_bytes`).
///
/// The output of this function must be passed to
/// [`crate::bullet_proof_create_with_message`] so the created output is
/// recoverable by [`recover_output`].
pub fn build_v3_proof_message(
    depth: u8,
    path: &[u32; 4],
    switch: SwitchCommitmentType,
) -> [u8; 20] {
    let mut msg = [0u8; 20];
    msg[2] = match switch {
        SwitchCommitmentType::None => 0,
        SwitchCommitmentType::Regular => 1,
    };
    msg[3] = depth;
    msg[4..8].copy_from_slice(&path[0].to_be_bytes());
    msg[8..12].copy_from_slice(&path[1].to_be_bytes());
    msg[12..16].copy_from_slice(&path[2].to_be_bytes());
    msg[16..20].copy_from_slice(&path[3].to_be_bytes());
    msg
}

/// Mint a fully **seed-recoverable** Grin output in one place: deterministic
/// view-key rewind nonce + embedded v3 identifier message. EVERY Grin output
/// Smirk creates routes through this, so every new output can be rediscovered
/// by [`recover_output`] from the seed alone (matching grin's `ProofBuilder`
/// in `grin/core/src/libtx/proof.rs::create`).
///
/// - `path` is the output's depth-4 derivation path (`[0, 0, n, 0]`, Smirk's
///   convention; depth is always 4).
/// - `blinding_factor` MUST equal `derive_blind(ext, path, amount, switch)`
///   (the same blind used for the commitment); otherwise recovery's
///   recomputed commitment won't match and the output is silently dropped.
///
/// Returns `(commitment, proof_bytes, rewind_nonce)`. The rewind nonce is
/// returned for callers that retain it (e.g. the receiver context); most
/// callers ignore it.
pub fn create_recoverable_output(
    extended_private_key: &[u8; 64],
    amount: u64,
    blinding_factor: &[u8; 32],
    path: &[u32; 4],
    switch: SwitchCommitmentType,
    private_nonce: &[u8; 32],
) -> Result<([u8; COMMITMENT_LEN], Vec<u8>, [u8; 32]), String> {
    let commitment = pedersen_commit(amount, blinding_factor)?;
    let rh = rewind_hash(extended_private_key)?;
    let rewind_nonce = output_rewind_nonce(&rh, &commitment)?;
    let message = build_v3_proof_message(4, path, switch);
    let proof = bullet_proof_create_with_message(
        amount,
        blinding_factor,
        &rewind_nonce,
        private_nonce,
        &message,
    )?;
    Ok((commitment, proof, rewind_nonce))
}

/// Parse a recovered proof message and confirm the output belongs to this
/// wallet by re-deriving its commitment from the seed.
///
/// Tries the v3 message format first (`msg[0..2]==0`, `msg[2]=switch`,
/// `msg[3]=depth<=4`, `msg[4..]=path`), then the legacy format
/// (`msg[0..4]==0`, forced depth=3, switch=Regular).
///
/// Returns `Some(RecoveredOutput)` only if the recomputed commitment equals
/// `commitment`; otherwise `None` (no false positives).
pub fn check_output(
    extended_private_key: &[u8; 64],
    commitment: &[u8; COMMITMENT_LEN],
    value: u64,
    message: &[u8],
) -> Result<Option<RecoveredOutput>, String> {
    // The Grin proof message is exactly 20 bytes.
    if message.len() != 20 {
        return Ok(None);
    }

    // --- v3 format: msg[0..2]==0, [2]=switch, [3]=depth, [4..20]=path ---
    if message[0] == 0 && message[1] == 0 {
        let switch = match message[2] {
            0 => Some(SwitchCommitmentType::None),
            1 => Some(SwitchCommitmentType::Regular),
            _ => None,
        };
        if let Some(switch) = switch {
            let depth = core::cmp::min(message[3], 4);
            if let Some(out) = try_recover(
                extended_private_key,
                commitment,
                value,
                depth,
                &message[4..20],
                switch,
            )? {
                return Ok(Some(out));
            }
        }
    }

    // --- legacy format: msg[0..4]==0, depth forced to 3, switch=Regular ---
    if message[0] == 0 && message[1] == 0 && message[2] == 0 && message[3] == 0 {
        if let Some(out) = try_recover(
            extended_private_key,
            commitment,
            value,
            3,
            &message[4..20],
            SwitchCommitmentType::Regular,
        )? {
            return Ok(Some(out));
        }
    }

    Ok(None)
}

/// Given a parsed (depth, 16-byte serialized path, switch), rebuild the
/// `Identifier`, derive the path that grin's `derive_key` actually walks
/// (`0..depth`), recompute the commitment, and confirm it matches.
fn try_recover(
    extended_private_key: &[u8; 64],
    commitment: &[u8; COMMITMENT_LEN],
    value: u64,
    depth: u8,
    serialized_path: &[u8],
    switch: SwitchCommitmentType,
) -> Result<Option<RecoveredOutput>, String> {
    if serialized_path.len() < IDENTIFIER_LEN - 1 {
        return Ok(None);
    }

    // Identifier layout: [0] = depth, [1..17] = 16-byte serialized path.
    let mut identifier = [0u8; IDENTIFIER_LEN];
    identifier[0] = depth;
    identifier[1..IDENTIFIER_LEN].copy_from_slice(&serialized_path[..IDENTIFIER_LEN - 1]);

    // The 4 u32 path elements (big-endian) from the 16 path bytes.
    let mut full_path = [0u32; 4];
    for (i, chunk) in serialized_path[..16].chunks_exact(4).enumerate() {
        full_path[i] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
    }

    // grin's derive_key walks only the first `depth` indices. Mirror that:
    // pass exactly `depth` elements to derive_blind.
    let depth_usize = depth as usize;
    let path: Vec<u32> = full_path[..depth_usize.min(4)].to_vec();

    let blinding_factor = derive_blind(extended_private_key, &path, value, switch)?;
    let recomputed = crate::bulletproof::pedersen_commit(value, &blinding_factor)?;

    if &recomputed != commitment {
        return Ok(None);
    }

    let n_child = if depth_usize == 0 {
        0
    } else {
        full_path[depth_usize.min(4) - 1]
    };

    Ok(Some(RecoveredOutput {
        value,
        identifier,
        path,
        n_child,
        switch,
        blinding_factor,
    }))
}

/// Recover a single output from the seed alone, given its on-chain
/// commitment and range proof.
///
/// Computes the wallet's rewind hash, derives the per-commitment nonce,
/// rewinds the proof (trying the v3 nonce first, then the legacy nonce),
/// and confirms via `check_output`. Returns `Some(RecoveredOutput)` if the
/// output belongs to this wallet, `None` otherwise.
///
/// This is the function the WASM binding (a later step) will call.
pub fn recover_output(
    extended_private_key: &[u8; 64],
    commitment: &[u8; COMMITMENT_LEN],
    proof_bytes: &[u8],
) -> Result<Option<RecoveredOutput>, String> {
    // --- v3 path: rewind_hash + commitment-keyed nonce ---
    let rh = rewind_hash(extended_private_key)?;
    let v3_nonce = output_rewind_nonce(&rh, commitment)?;
    if let Some((value, _blind, message, _mlen)) =
        bullet_proof_rewind_with_message(commitment, &v3_nonce, proof_bytes)?
    {
        if let Some(out) = check_output(extended_private_key, commitment, value, &message)? {
            return Ok(Some(out));
        }
    }

    // --- legacy path: legacy_root_hash + commitment-keyed nonce ---
    let lrh = legacy_root_hash(extended_private_key)?;
    let legacy_nonce = legacy_output_rewind_nonce(&lrh, commitment)?;
    if let Some((value, _blind, message, _mlen)) =
        bullet_proof_rewind_with_message(commitment, &legacy_nonce, proof_bytes)?
    {
        if let Some(out) = check_output(extended_private_key, commitment, value, &message)? {
            return Ok(Some(out));
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// rewind_hash is deterministic and 32 bytes, non-zero.
    #[test]
    fn rewind_hash_is_deterministic_nonzero() {
        let mut ext = [0u8; 64];
        ext[..32].copy_from_slice(&[0x42u8; 32]);
        ext[32..].copy_from_slice(&[0x77u8; 32]);
        let a = rewind_hash(&ext).unwrap();
        let b = rewind_hash(&ext).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, [0u8; 32]);
    }

    /// The v3 nonce depends on the commitment (the BLAKE2b key).
    #[test]
    fn nonce_depends_on_commitment() {
        let rh = [0x11u8; 32];
        let mut c1 = [0u8; COMMITMENT_LEN];
        c1[0] = 0x09;
        let mut c2 = c1;
        c2[1] ^= 1;
        let n1 = output_rewind_nonce(&rh, &c1).unwrap();
        let n2 = output_rewind_nonce(&rh, &c2).unwrap();
        assert_ne!(n1, n2);
    }

    /// Empty-key BLAKE2b (rewind_hash) must NOT equal keyed BLAKE2b with the
    /// same bytes as key: proves the key path actually changes the output.
    #[test]
    fn keyed_vs_unkeyed_differ() {
        let data = [0xABu8; 32];
        let mut unkeyed = Blake2bVar::new(32).unwrap();
        unkeyed.update(&data);
        let mut u = [0u8; 32];
        unkeyed.finalize_variable(&mut u).unwrap();

        let keyed = keyed_blake2b_256(&[0xCDu8; 33], &data).unwrap();
        assert_ne!(u, keyed);
    }

    // ---- create → recover round-trip (the local proof of step 6) ----
    //
    // These build an output exactly as step 6 wires the 6 grin-ext
    // creation sites (derive_blind → commit → deterministic rewind nonce →
    // build_v3_proof_message → bullet_proof_create_with_message) and assert
    // recover_output finds it. Unlike the grin_recovery_vectors.rs vectors
    // (which use grin's own ProofBuilder and a [0,0,3,9] path), this proves
    // Smirk's create side recovers Smirk's create side, on Smirk's ACTUAL
    // [0,0,n,0] depth-4 path layout.

    use crate::bulletproof::{bullet_proof_create_with_message, pedersen_commit};

    #[test]
    fn smirk_create_recover_roundtrip_depth4_0_0_n_0() {
        let ext = [0x11u8; 64];
        let amount: u64 = 1_000_000_000; // 1 GRIN
        let n: u32 = 7;
        let path = [0u32, 0, n, 0]; // Smirk's real path layout
        let switch = SwitchCommitmentType::Regular;

        // CREATE side (mirrors the 6 step-6 sites exactly).
        let blind = derive_blind(&ext, &path, amount, switch).unwrap();
        let commit = pedersen_commit(amount, &blind).unwrap();
        let rh = rewind_hash(&ext).unwrap();
        let rewind_nonce = output_rewind_nonce(&rh, &commit).unwrap();
        let private_nonce = [0x33u8; 32]; // random in prod; irrelevant to recovery
        let msg = build_v3_proof_message(4, &path, switch);
        let proof =
            bullet_proof_create_with_message(amount, &blind, &rewind_nonce, &private_nonce, &msg)
                .unwrap();

        // RECOVER side.
        let rec = recover_output(&ext, &commit, &proof)
            .unwrap()
            .expect("a Smirk-created output MUST be recoverable from the seed alone");

        assert_eq!(rec.value, amount, "recovered value");
        assert_eq!(rec.path, vec![0, 0, n, 0], "full depth-4 path");
        assert_eq!(rec.path[2], n, "spendable child index lives in path[2]");
        assert_eq!(rec.n_child, 0, "grin n_child = path[depth-1] = trailing 0");
        assert_eq!(rec.identifier[0], 4, "depth byte");
        assert_eq!(rec.switch, SwitchCommitmentType::Regular);
        // The re-derived spendable blind reproduces the commitment (no false
        // positive, and the output is actually spendable post-recovery).
        let recommit = pedersen_commit(rec.value, &rec.blinding_factor).unwrap();
        assert_eq!(recommit, commit, "re-derived blind must reproduce the commitment");
    }

    #[test]
    fn smirk_create_recover_roundtrip_switch_none() {
        // Lock the switch-byte mapping (None → 0) end-to-end.
        let ext = [0x11u8; 64];
        let amount: u64 = 42_000_000;
        let path = [0u32, 0, 3, 0];
        let switch = SwitchCommitmentType::None;

        let blind = derive_blind(&ext, &path, amount, switch).unwrap();
        let commit = pedersen_commit(amount, &blind).unwrap();
        let rewind_nonce = output_rewind_nonce(&rewind_hash(&ext).unwrap(), &commit).unwrap();
        let msg = build_v3_proof_message(4, &path, switch);
        let proof =
            bullet_proof_create_with_message(amount, &blind, &rewind_nonce, &[0x55u8; 32], &msg)
                .unwrap();

        let rec = recover_output(&ext, &commit, &proof)
            .unwrap()
            .expect("recoverable with switch=None");
        assert_eq!(rec.switch, SwitchCommitmentType::None);
        assert_eq!(rec.value, amount);
        assert_eq!(rec.path[2], 3);
    }

    #[test]
    fn smirk_created_output_not_recovered_by_wrong_seed() {
        let ext = [0x11u8; 64];
        let other = [0x22u8; 64];
        let path = [0u32, 0, 5, 0];
        let amount: u64 = 500_000_000;
        let switch = SwitchCommitmentType::Regular;

        let blind = derive_blind(&ext, &path, amount, switch).unwrap();
        let commit = pedersen_commit(amount, &blind).unwrap();
        let rewind_nonce = output_rewind_nonce(&rewind_hash(&ext).unwrap(), &commit).unwrap();
        let msg = build_v3_proof_message(4, &path, switch);
        let proof =
            bullet_proof_create_with_message(amount, &blind, &rewind_nonce, &[0x44u8; 32], &msg)
                .unwrap();

        assert!(
            recover_output(&other, &commit, &proof).unwrap().is_none(),
            "a different wallet must NOT recover this output"
        );
    }
}
