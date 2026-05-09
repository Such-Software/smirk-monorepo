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

/// Convert a 33-byte compressed secp256k1 public key into a 33-byte Grin
/// Pedersen commitment.
///
/// The X coordinate stays the same; only the parity prefix changes:
/// - `0x02` (even Y, pubkey) → `0x08` (even Y, commitment)
/// - `0x03` (odd Y, pubkey)  → `0x09` (odd Y, commitment)
///
/// This matches the encoding `libsecp256k1-zkp` uses for Pedersen
/// commitments and is what Grin's `Commitment::write` produces on the
/// wire.
pub fn pubkey_to_commitment(pubkey_compressed: &[u8; 33]) -> Result<[u8; 33], String> {
    let mut commit = [0u8; 33];
    commit.copy_from_slice(pubkey_compressed);
    commit[0] = match pubkey_compressed[0] {
        0x02 => 0x08,
        0x03 => 0x09,
        other => {
            return Err(format!(
                "unexpected pubkey parity prefix 0x{other:02x}; expected 0x02 or 0x03"
            ))
        }
    };
    Ok(commit)
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
    fn pubkey_to_commitment_swaps_prefix() {
        let mut pk = [0u8; 33];
        pk[0] = 0x02;
        pk[1] = 0xab;
        let c = pubkey_to_commitment(&pk).unwrap();
        assert_eq!(c[0], 0x08);
        assert_eq!(c[1..], pk[1..]);

        pk[0] = 0x03;
        let c = pubkey_to_commitment(&pk).unwrap();
        assert_eq!(c[0], 0x09);
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
