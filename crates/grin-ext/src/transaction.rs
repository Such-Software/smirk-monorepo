//! Build broadcastable Grin Transaction wire-format bytes from a finalized
//! S3 slate.
//!
//! Reference: `grin/core/src/core/transaction.rs::Transaction::write` plus
//! `TransactionBody::write`. Wire format:
//!
//! ```text
//!   offset       (32 bytes BlindingFactor — same as slate.off)
//!   num_inputs   (u64 BE)
//!   num_outputs  (u64 BE)
//!   num_kernels  (u64 BE)
//!   inputs[]:    each `(u8 features) || (33-byte commitment)`
//!   outputs[]:   each `(u8 features) || (33-byte commitment) || (u64 BE rangeproof_len) || rangeproof_bytes`
//!   kernels[]:   each `(KernelFeatures v2 bytes) || (33-byte excess commitment) || (64-byte signature)`
//! ```
//!
//! Inputs use `Inputs::FeaturesAndCommit` representation (the
//! protocol-version-agnostic encoding). Single-kernel transactions only,
//! which covers every standard send + invoice flow.
//!
//! ## Kernel excess derivation
//!
//! The kernel `excess` field is a Pedersen commitment to zero, blinded
//! by the aggregate of all participants' blind excesses. Concretely it
//! equals `(Σ slate.sigs[i].xs)` reinterpreted with Grin's commitment
//! prefix encoding (0x08 / 0x09 instead of secp256k1's 0x02 / 0x03 for
//! even/odd Y respectively).
//!
//! See [`pubkey_to_commitment`] for the prefix-swap conversion. The X
//! coordinate is identical between encodings — both are 33-byte
//! compressed-form points on secp256k1.

use crate::kernel::KernelFeatures;
use crate::schnorr::point_add;
use crate::slate::{SlateStateV4, SlateV4};

/// One transaction input — a reference to an existing UTXO being spent.
#[derive(Debug, Clone)]
pub struct TxInput {
    /// Output features of the UTXO being spent. `0` = Plain, `1` = Coinbase.
    pub features: u8,
    /// 33-byte Pedersen commitment of the UTXO being spent (with Grin's
    /// 0x08/0x09 prefix encoding).
    pub commitment: [u8; 33],
}

/// One transaction output — a new UTXO being created.
#[derive(Debug, Clone)]
pub struct TxOutput {
    /// Output features. `0` = Plain, `1` = Coinbase.
    pub features: u8,
    /// 33-byte Pedersen commitment.
    pub commitment: [u8; 33],
    /// Variable-length Bulletproof rangeproof bytes (typically ~676 for
    /// a single 64-bit range).
    pub rangeproof: Vec<u8>,
}

/// All the data needed to build a broadcastable Transaction from a
/// finalized S3 slate. The slate carries the kernel offset, kernel
/// features, participant pubkeys (which sum to the kernel excess), and
/// the receiver's output (in `coms`). The sender supplies the rest:
/// their input UTXOs, their change outputs, and the aggregated kernel
/// signature (which `sender_finalize_s3` returns).
#[derive(Debug, Clone)]
pub struct BuildTransactionParams {
    pub s3_slate: SlateV4,
    pub sender_inputs: Vec<TxInput>,
    pub sender_change_outputs: Vec<TxOutput>,
    pub aggregated_kernel_signature: [u8; 64],
}

/// Convert a finalized S3 slate + sender's local input/change data + the
/// aggregated kernel signature into the binary wire format Grin daemons
/// accept on their `/v2/foreign push_transaction` endpoint.
pub fn slate_to_transaction_bytes(params: &BuildTransactionParams) -> Result<Vec<u8>, String> {
    let slate = &params.s3_slate;

    // Sanity checks
    if slate.sta != SlateStateV4::Standard3 {
        return Err(format!(
            "slate_to_transaction_bytes expects S3, got {:?}",
            slate.sta
        ));
    }
    if slate.sigs.is_empty() {
        return Err("S3 slate must contain at least one participant".to_string());
    }

    // Collect all outputs: receiver's (from slate.coms) plus sender's
    // change outputs (passed in by the caller).
    let mut all_outputs: Vec<TxOutput> = Vec::new();
    if let Some(coms) = &slate.coms {
        for c in coms {
            let proof = c.p.clone().ok_or_else(|| {
                "output in slate.coms is missing its rangeproof — cannot build TX".to_string()
            })?;
            all_outputs.push(TxOutput {
                features: c.f,
                commitment: c.c,
                rangeproof: proof,
            });
        }
    }
    all_outputs.extend(params.sender_change_outputs.iter().cloned());

    // Compute kernel excess = sum of all participants' xs (the public
    // blind-excess pubkeys) reinterpreted in commitment-prefix encoding.
    let mut p_total = slate.sigs[0].xs;
    for sig in &slate.sigs[1..] {
        p_total = point_add(&p_total, &sig.xs)?;
    }
    let kernel_excess = pubkey_to_commitment(&p_total)?;

    // Reconstruct kernel features (Plain/Coinbase/HeightLocked/NRD) and
    // serialize them in v2 protocol wire format.
    let kernel_features = KernelFeatures::from_slate_fields(
        slate.feat,
        slate.fee,
        slate.feat_args.as_ref().map(|a| a.lock_hgt),
    )?;
    let kernel_features_bytes = kernel_features.to_v2_bytes()?;

    // Serialize the full transaction.
    let mut out = Vec::with_capacity(
        32 // offset
            + 24 // 3 length u64 BE
            + params.sender_inputs.len() * (1 + 33)
            + all_outputs.iter().map(|o| 1 + 33 + 8 + o.rangeproof.len()).sum::<usize>()
            + kernel_features_bytes.len()
            + 33 // kernel excess
            + 64, // kernel signature
    );

    // Offset
    out.extend_from_slice(&slate.off);

    // Counts
    out.extend_from_slice(&(params.sender_inputs.len() as u64).to_be_bytes());
    out.extend_from_slice(&(all_outputs.len() as u64).to_be_bytes());
    out.extend_from_slice(&1u64.to_be_bytes()); // single-kernel transaction

    // Inputs
    for input in &params.sender_inputs {
        out.push(input.features);
        out.extend_from_slice(&input.commitment);
    }

    // Outputs
    for output in &all_outputs {
        out.push(output.features);
        out.extend_from_slice(&output.commitment);
        out.extend_from_slice(&(output.rangeproof.len() as u64).to_be_bytes());
        out.extend_from_slice(&output.rangeproof);
    }

    // Kernel: features || excess || signature
    out.extend_from_slice(&kernel_features_bytes);
    out.extend_from_slice(&kernel_excess);
    out.extend_from_slice(&params.aggregated_kernel_signature);

    Ok(out)
}

/// Same as [`slate_to_transaction_bytes`] but emits the JSON object
/// shape that Grin's node `/v2/foreign push_transaction` JSON-RPC
/// endpoint expects as its `tx` parameter.
///
/// The binary wire format and the JSON-RPC format carry identical
/// data — the difference is just encoding. push_transaction does NOT
/// accept the raw binary form; it deserializes a `Transaction` struct
/// from JSON, which means we have to emit the exact shape Grin's
/// `#[derive(Serialize)]` for `Transaction` produces.
///
/// The shape (mirrors `grin/core/src/core/transaction.rs`):
///
/// ```text
/// {
///   "offset": "<32-byte hex>",
///   "body": {
///     "inputs":  [ {"features": "Plain"|"Coinbase", "commit": "<33-byte hex>"} ],
///     "outputs": [ {"features": "Plain"|"Coinbase", "commit": "<33-byte hex>", "proof": "<bp hex>"} ],
///     "kernels": [ {"features": "Plain"|..., "fee": "<u64-string>", "lock_height": "<u64-string>"?, "excess": "<33-byte hex>", "excess_sig": "<64-byte hex>"} ]
///   }
/// }
/// ```
///
/// `fee` and `lock_height` serialize as JSON STRINGS (grin uses a
/// stringified-u64 helper for these), not numbers. `features` on
/// kernels flattens to the top level of the kernel object (Grin's
/// TxKernel uses `#[serde(flatten)]` on the features field).
pub fn slate_to_transaction_json(
    params: &BuildTransactionParams,
) -> Result<serde_json::Value, String> {
    let slate = &params.s3_slate;

    if slate.sta != SlateStateV4::Standard3 {
        return Err(format!(
            "slate_to_transaction_json expects S3, got {:?}",
            slate.sta
        ));
    }
    if slate.sigs.is_empty() {
        return Err("S3 slate must contain at least one participant".to_string());
    }

    let mut all_outputs: Vec<TxOutput> = Vec::new();
    if let Some(coms) = &slate.coms {
        for c in coms {
            let proof = c.p.clone().ok_or_else(|| {
                "output in slate.coms is missing its rangeproof — cannot build TX".to_string()
            })?;
            all_outputs.push(TxOutput {
                features: c.f,
                commitment: c.c,
                rangeproof: proof,
            });
        }
    }
    all_outputs.extend(params.sender_change_outputs.iter().cloned());

    let mut p_total = slate.sigs[0].xs;
    for sig in &slate.sigs[1..] {
        p_total = point_add(&p_total, &sig.xs)?;
    }
    let kernel_excess = pubkey_to_commitment(&p_total)?;

    let kernel_features = KernelFeatures::from_slate_fields(
        slate.feat,
        slate.fee,
        slate.feat_args.as_ref().map(|a| a.lock_hgt),
    )?;

    let feature_str = |f: u8| -> &'static str {
        match f {
            1 => "Coinbase",
            _ => "Plain",
        }
    };

    // Sort inputs + outputs in grin_core's canonical order:
    // `Blake2b256(wire_serialize(item))`. The `hashable_ord!` macro on
    // grin_core::core::transaction::{Input, Output} implements Ord as
    // `self.hash().cmp(&other.hash())`, and Transaction::validate runs
    // `verify_sorted_and_unique`. Unsorted inputs/outputs fail with
    // `Serialization(SortError)`, which surfaces at the node as
    // "Invalid Tx some kind of keychain error".
    //
    // Wire serialization (per grin_core/src/core/transaction.rs):
    //   Input:  features (u8) || commit (33 bytes)
    //   Output: features (u8) || commit (33 bytes) || proof_len (u64 BE) || proof bytes
    //
    // The hash function is Blake2b-256 (BLAKE2b output truncated to
    // 32 bytes — same primitive we use for sig_msg).
    use blake2::digest::{Update, VariableOutput};
    use blake2::Blake2bVar;
    let hash_bytes = |bytes: &[u8]| -> [u8; 32] {
        let mut h = Blake2bVar::new(32).expect("blake2b 32");
        h.update(bytes);
        let mut out = [0u8; 32];
        h.finalize_variable(&mut out).expect("blake2b finalize");
        out
    };
    let input_hash = |i: &TxInput| -> [u8; 32] {
        let mut buf = Vec::with_capacity(34);
        buf.push(i.features);
        buf.extend_from_slice(&i.commitment);
        hash_bytes(&buf)
    };
    // Output sorts by its OutputIdentifier hash (features + commit
    // ONLY — proof is NOT hashed for the Ord impl; see grin_core
    // transaction.rs line 2017 `impl Ord for Output { ... cmp via
    // self.identifier }` and line 2160 `hashable_ord!(OutputIdentifier)`
    // where OutputIdentifier::Writeable is just features + commit).
    let output_hash = |o: &TxOutput| -> [u8; 32] {
        let mut buf = Vec::with_capacity(34);
        buf.push(o.features);
        buf.extend_from_slice(&o.commitment);
        hash_bytes(&buf)
    };

    let mut sorted_inputs: Vec<&TxInput> = params.sender_inputs.iter().collect();
    sorted_inputs.sort_by_key(|i| input_hash(i));
    let inputs_json: Vec<serde_json::Value> = sorted_inputs
        .iter()
        .map(|i| {
            serde_json::json!({
                "features": feature_str(i.features),
                "commit": hex::encode(i.commitment),
            })
        })
        .collect();

    let mut sorted_outputs: Vec<&TxOutput> = all_outputs.iter().collect();
    sorted_outputs.sort_by_key(|o| output_hash(o));
    let outputs_json: Vec<serde_json::Value> = sorted_outputs
        .iter()
        .map(|o| {
            serde_json::json!({
                "features": feature_str(o.features),
                "commit": hex::encode(o.commitment),
                "proof": hex::encode(&o.rangeproof),
            })
        })
        .collect();

    // Kernel: `TxKernel { features: KernelFeatures, excess, excess_sig }`
    // — KernelFeatures is a nested struct, not flattened. KernelFeatures
    // uses default external tagging:
    //   Plain        → {"Plain": {"fee": <u64-int>}}
    //   Coinbase     → "Coinbase"
    //   HeightLocked → {"HeightLocked": {"fee": <u64-int>, "lock_height": <u64-int>}}
    //   NRD          → {"NoRecentDuplicate": {"fee": ..., "relative_height": <u16-int>}}
    // `fee` serializes via `fee_fields_as_int` — packed-u64 INT (not a
    // stringified one). lock_height / relative_height likewise are bare
    // numbers. Empirically verified against
    // grin_core::core::transaction::{KernelFeatures, TxKernel} in
    // grin_core 5.4.
    let features_json = match kernel_features {
        KernelFeatures::Plain { fee } => serde_json::json!({"Plain": {"fee": fee}}),
        KernelFeatures::Coinbase => serde_json::json!("Coinbase"),
        KernelFeatures::HeightLocked { fee, lock_height } => serde_json::json!({
            "HeightLocked": {"fee": fee, "lock_height": lock_height}
        }),
        KernelFeatures::Nrd { fee, relative_height } => serde_json::json!({
            "NoRecentDuplicate": {"fee": fee, "relative_height": relative_height}
        }),
    };
    // CRITICAL: grin's `sig_serde::deserialize` (in grin_core/libtx/secp_ser.rs)
    // calls `secp256k1zkp::Signature::from_compact`, which routes through
    // `secp256k1_ecdsa_signature_parse_compact` + `_save`. Internally that
    // parses the 64 BE input bytes as two scalars via `scalar_set_b32`, then
    // `memcpy`s the scalar limbs back into `Signature::data`. On x86_64 the
    // scalar limbs (`uint64_t d[4]`) are little-endian, so the memcpy result
    // is the original 32-byte BE half **byte-reversed**.
    //
    // grin's aggsig verifier (`secp256k1_aggsig_verify_single`) then reads
    // `sig.data[0..32]` directly as BE for the field element R.x and as BE
    // for the scalar s — i.e., it expects the post-from_compact storage to
    // already be in BE form. For grin-wallet's own kernels this works
    // because they round-trip a sig through `serialize_compact` (which is
    // the inverse of `from_compact`) before hex-encoding, and the two
    // operations cancel out.
    //
    // We never run `serialize_compact`, so we pre-apply its byte-reversal
    // here. After grin's `from_compact` undoes the reversal, sig.data
    // contains the canonical BE (R.x || s) bytes that aggsig_verify_single
    // expects. Empirically verified against `kernel.excess_sig.to_raw_data()`
    // in `full_send_round_trip_validates_against_grin_wallet`.
    let mut kernel_sig_for_json = [0u8; 64];
    let sig = &params.aggregated_kernel_signature;
    for i in 0..32 {
        kernel_sig_for_json[i] = sig[31 - i];
        kernel_sig_for_json[32 + i] = sig[63 - i];
    }
    let kernel_obj = serde_json::json!({
        "features": features_json,
        "excess": hex::encode(kernel_excess),
        "excess_sig": hex::encode(kernel_sig_for_json),
    });

    Ok(serde_json::json!({
        "offset": hex::encode(slate.off),
        "body": {
            "inputs": inputs_json,
            "outputs": outputs_json,
            "kernels": [kernel_obj],
        },
    }))
}

/// Convert a 33-byte compressed secp256k1 public key into a 33-byte Grin
/// Pedersen commitment.
///
/// **NOT** a simple `02↔08 / 03↔09` prefix swap. libsecp256k1-zkp's
/// `secp256k1_pubkey_to_pedersen_commitment` does a Y-coordinate flip
/// (the commit form negates the pubkey internally), so an odd-Y pubkey
/// maps to an even-Y commitment and vice versa. We were doing the
/// naive prefix swap — every kernel.excess we wrote to chain since the
/// monorepo migration was for the wrong point, which the node would
/// reject with "Invalid Tx some kind of keychain error" (incorrect
/// signature, because the verifier's pubkey-derived-from-commit
/// didn't match the pubkey our sig was generated against).
///
/// Delegate to libsecp256k1-zkp's canonical implementation so we
/// always agree with grin-wallet's `Slate::calc_excess` which uses
/// `Commitment::from_pubkey(secp, &pub_blind_sum)`.
///
/// Verified against this canonical fn by
/// `pubkey_to_commitment_matches_secp_from_pubkey` in
/// `crates/grin-ext/tests/grin_wallet_compat.rs`.
pub fn pubkey_to_commitment(pubkey_compressed: &[u8; 33]) -> Result<[u8; 33], String> {
    use secp256k1zkp::key::PublicKey;
    use secp256k1zkp::pedersen::Commitment;
    use secp256k1zkp::{ContextFlag, Secp256k1};
    let secp = Secp256k1::with_caps(ContextFlag::Commit);
    let pk = PublicKey::from_slice(&secp, pubkey_compressed)
        .map_err(|e| format!("invalid 33-byte compressed pubkey: {e}"))?;
    let commit: Commitment = Commitment::from_pubkey(&secp, &pk)
        .map_err(|e| format!("Commitment::from_pubkey failed: {e}"))?;
    Ok(commit.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bulletproof::{bullet_proof_create, pedersen_commit};
    use crate::slate_builder::{
        receiver_round_s2, sender_finalize_s3, sender_init_s1, ReceiverRoundParams,
        SenderFinalizeParams, SenderInitParams,
    };

    fn det(b: u8) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[31] = b.max(1);
        out
    }

    #[test]
    fn pubkey_to_commitment_returns_valid_commit() {
        // The old "naive prefix swap" assertion is gone — the canonical
        // conversion done by libsecp256k1-zkp internally negates the
        // pubkey, so prefix may flip parity. Just check the conversion
        // round-trips through Commitment::to_pubkey for a known valid
        // pubkey constructed from a small secret key.
        use secp256k1zkp::key::{PublicKey, SecretKey};
        use secp256k1zkp::pedersen::Commitment;
        use secp256k1zkp::{ContextFlag, Secp256k1};
        let secp = Secp256k1::with_caps(ContextFlag::Commit);
        let mut sk_bytes = [0u8; 32];
        sk_bytes[31] = 0x42;
        let sk = SecretKey::from_slice(&secp, &sk_bytes).unwrap();
        let pk = PublicKey::from_secret_key(&secp, &sk).unwrap();
        let pk_ser = pk.serialize_vec(&secp, true);
        let mut pk_arr = [0u8; 33];
        pk_arr.copy_from_slice(&pk_ser);

        let commit_bytes = pubkey_to_commitment(&pk_arr).unwrap();
        // Commit prefix must be 0x08 or 0x09.
        assert!(matches!(commit_bytes[0], 0x08 | 0x09));

        // Round-trip: the resulting commitment's to_pubkey must equal
        // the original pubkey (this is the property the node will use
        // when verifying our kernel signature).
        let commit = Commitment(commit_bytes);
        let recovered = commit.to_pubkey(&secp).unwrap();
        assert_eq!(
            recovered.serialize_vec(&secp, true)[..],
            pk_ser[..],
            "Commit→Pubkey round-trip must recover the original pubkey"
        );
    }

    #[test]
    fn pubkey_to_commitment_rejects_invalid_prefix() {
        let pk = [0xffu8; 33];
        assert!(pubkey_to_commitment(&pk).is_err());
    }

    #[test]
    fn rejects_non_s3_slate() {
        let init = sender_init_s1(&SenderInitParams {
            amount: 1,
            fee: 1,
            kernel_features: KernelFeatures::Plain { fee: 1 },
            sender_blind_excess: det(11),
            kernel_offset: det(22),
            kernel_nonce: det(33),
        })
        .unwrap();
        // Pass S1 (not S3) slate.
        let params = BuildTransactionParams {
            s3_slate: init.slate,
            sender_inputs: vec![],
            sender_change_outputs: vec![],
            aggregated_kernel_signature: [0u8; 64],
        };
        assert!(slate_to_transaction_bytes(&params).is_err());
    }

    /// Run the full ceremony then build a TX from the result, parse it
    /// back, and verify the structure round-trips.
    #[test]
    fn end_to_end_full_ceremony_to_transaction_bytes() {
        let amount = 60_000_000_000u64;
        let fee = 7_000_000u64;
        let kernel_features = KernelFeatures::Plain { fee };

        // Run the full S1 → S2 → S3 ceremony.
        let init = sender_init_s1(&SenderInitParams {
            amount,
            fee,
            kernel_features,
            sender_blind_excess: det(11),
            kernel_offset: det(22),
            kernel_nonce: det(33),
        })
        .unwrap();
        let s2 = receiver_round_s2(&ReceiverRoundParams {
            s1_slate: init.slate,
            receiver_output_blind: det(101),
            receiver_kernel_nonce: det(102),
            bp_rewind_nonce: det(103),
            bp_private_nonce: det(104),
        })
        .unwrap();
        let s3 = sender_finalize_s3(&SenderFinalizeParams {
            s2_slate: s2.slate,
            sender_context: init.context,
        })
        .unwrap();

        // Sender's local input + change data (would come from the wallet's
        // UTXO set in production). Use deterministic values so the test
        // has byte-stable output.
        let sender_input_blind = det(50);
        let sender_input_commit = pedersen_commit(amount + fee + 100, &sender_input_blind).unwrap();

        let change_blind = det(51);
        let change_value = 100u64;
        let change_commit = pedersen_commit(change_value, &change_blind).unwrap();
        let change_proof = bullet_proof_create(
            change_value,
            &change_blind,
            &det(52),
            &det(53),
        )
        .unwrap();

        let params = BuildTransactionParams {
            s3_slate: s3.slate.clone(),
            sender_inputs: vec![TxInput {
                features: 0,
                commitment: sender_input_commit,
            }],
            sender_change_outputs: vec![TxOutput {
                features: 0,
                commitment: change_commit,
                rangeproof: change_proof,
            }],
            aggregated_kernel_signature: s3.final_signature,
        };

        let tx_bytes = slate_to_transaction_bytes(&params).expect("build TX bytes");

        // Sanity checks on the structure.
        // First 32 bytes: kernel offset (matches slate.off).
        assert_eq!(&tx_bytes[..32], &s3.slate.off);
        // Next 8 bytes: num_inputs as u64 BE = 1
        assert_eq!(&tx_bytes[32..40], &1u64.to_be_bytes());
        // Next 8 bytes: num_outputs as u64 BE = 2 (receiver + change)
        assert_eq!(&tx_bytes[40..48], &2u64.to_be_bytes());
        // Next 8 bytes: num_kernels as u64 BE = 1
        assert_eq!(&tx_bytes[48..56], &1u64.to_be_bytes());

        // Verify the input section starts right after the counts:
        // tx_bytes[56] = input features byte
        assert_eq!(tx_bytes[56], 0); // Plain
        // tx_bytes[57..90] = input commitment (33 bytes)
        assert_eq!(&tx_bytes[57..90], &sender_input_commit);

        // The kernel's signature is the last 64 bytes of the TX.
        let n = tx_bytes.len();
        assert_eq!(&tx_bytes[n - 64..n], &s3.final_signature);

        // Total length sanity: at least
        //   32 (offset) + 24 (counts) + 34 (input) + 2*(34 + 8 + bp_size)
        //   + (1 + 8 for plain features) + 33 (excess) + 64 (sig)
        // Bullet proofs are ~676 bytes typically.
        assert!(tx_bytes.len() > 1000, "expected substantial TX bytes, got {}", tx_bytes.len());

        // Verify the JSON shape matches what grin_core::Transaction
        // serde would produce. Print + assert key fields so a curl at
        // the node can validate against this output before doing
        // another popup roundtrip.
        let tx_json = slate_to_transaction_json(&params).expect("build TX json");
        eprintln!("--- slate_to_transaction_json output ---");
        eprintln!("{}", serde_json::to_string_pretty(&tx_json).unwrap());
        eprintln!("--- end ---");
        assert!(tx_json["offset"].is_string(), "offset must be a hex string");
        assert!(tx_json["body"]["inputs"].is_array());
        let kernel = &tx_json["body"]["kernels"][0];
        // KernelFeatures must be the nested-object tagged shape (NOT
        // a flat "features": "Plain"). This is the bug that caused
        // grin to reject every broadcast with -32602 InvalidArgStructure.
        assert!(
            kernel["features"].is_object(),
            "kernel.features must be an object like {{\"Plain\":{{\"fee\":N}}}}, got {:?}",
            kernel["features"]
        );
        assert!(
            kernel["features"]["Plain"]["fee"].is_number(),
            "kernel.features.Plain.fee must be a JSON number (int), got {:?}",
            kernel["features"]["Plain"]["fee"]
        );
        assert!(kernel["excess"].is_string());
        assert!(kernel["excess_sig"].is_string());
    }

    #[test]
    fn empty_inputs_and_outputs_still_serializes() {
        // Edge case: no inputs (which would never happen in practice, but
        // we want to verify the count fields encode 0 correctly).
        let init = sender_init_s1(&SenderInitParams {
            amount: 1,
            fee: 1,
            kernel_features: KernelFeatures::Plain { fee: 1 },
            sender_blind_excess: det(11),
            kernel_offset: det(22),
            kernel_nonce: det(33),
        })
        .unwrap();
        // Move directly to a fake S3 with no coms (skipping the receiver step).
        let mut fake_s3 = init.slate;
        fake_s3.sta = SlateStateV4::Standard3;

        let params = BuildTransactionParams {
            s3_slate: fake_s3,
            sender_inputs: vec![],
            sender_change_outputs: vec![],
            aggregated_kernel_signature: [0u8; 64],
        };
        let tx_bytes = slate_to_transaction_bytes(&params).unwrap();
        // 32 offset + 24 counts + 0 inputs + 0 outputs + 9 kernel features
        // (Plain = 1 byte feature + 8 bytes fee BE) + 33 excess + 64 sig
        // = 32 + 24 + 9 + 33 + 64 = 162
        assert_eq!(tx_bytes.len(), 162);
        assert_eq!(&tx_bytes[32..40], &0u64.to_be_bytes()); // num_inputs
        assert_eq!(&tx_bytes[40..48], &0u64.to_be_bytes()); // num_outputs
        assert_eq!(&tx_bytes[48..56], &1u64.to_be_bytes()); // num_kernels
    }

    #[test]
    fn kernel_features_serialized_in_v2_format_for_nrd() {
        // Build an NRD-flavored S3 slate and verify the kernel features
        // bytes match what KernelFeatures::to_v2_bytes produces for NRD.
        let kernel_features = KernelFeatures::Nrd {
            fee: 8_000_000,
            relative_height: 1440,
        };
        let init = sender_init_s1(&SenderInitParams {
            amount: 1_000_000_000,
            fee: 8_000_000,
            kernel_features,
            sender_blind_excess: det(11),
            kernel_offset: det(22),
            kernel_nonce: det(33),
        })
        .unwrap();
        let s2 = receiver_round_s2(&ReceiverRoundParams {
            s1_slate: init.slate,
            receiver_output_blind: det(101),
            receiver_kernel_nonce: det(102),
            bp_rewind_nonce: det(103),
            bp_private_nonce: det(104),
        })
        .unwrap();
        let s3 = sender_finalize_s3(&SenderFinalizeParams {
            s2_slate: s2.slate,
            sender_context: init.context,
        })
        .unwrap();

        let params = BuildTransactionParams {
            s3_slate: s3.slate,
            sender_inputs: vec![],
            sender_change_outputs: vec![],
            aggregated_kernel_signature: s3.final_signature,
        };
        let tx_bytes = slate_to_transaction_bytes(&params).unwrap();
        // Locate the kernel section: offset + counts + inputs (0) + outputs (1 receiver)
        // 32 + 24 + 0 + (1 + 33 + 8 + bp_len_bytes)
        // The kernel features bytes should be the start of the kernel section.
        // For NRD: 11 bytes (1 type + 8 fee + 2 relative_height).
        // The exact location depends on the BP size; we just verify the
        // expected NRD kernel-features bytes appear somewhere in the TX.
        let expected_features_bytes = kernel_features.to_v2_bytes().unwrap();
        let found = tx_bytes
            .windows(expected_features_bytes.len())
            .any(|w| w == expected_features_bytes);
        assert!(
            found,
            "expected NRD kernel features bytes ({expected_features_bytes:?}) to appear in TX"
        );
    }
}
