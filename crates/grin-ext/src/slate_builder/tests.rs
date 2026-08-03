//! Slate-builder ceremony tests: both standard (S1→S2→S3) and invoice
//! (I1→I2→I3).
//!
//! Helpers (`det`, `build_s1`, `run_full_ceremony`) are shared, so we keep
//! the tests in one module rather than splitting alongside `standard.rs`
//! / `invoice.rs`.

use super::*;
use crate::slate::{serialize_slate_v4, SlateStateV4, SlateV4};

fn det(b: u8) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[31] = b.max(1); // ensure non-zero
    out
}

// =========================================================================
// Standard: sender_init_s1
// =========================================================================

#[test]
fn sender_init_produces_valid_s1() {
    let params = SenderInitParams {
        amount: 60_000_000_000,
        fee: 7_000_000,
        kernel_features: KernelFeatures::Plain { fee: 7_000_000 },
        sender_blind_excess: det(11),
        kernel_offset: det(22),
        kernel_nonce: det(33),
    };
    let out = sender_init_s1(&params).expect("sender_init succeeds");

    // Shape checks.
    assert_eq!(out.slate.sta, SlateStateV4::Standard1);
    assert_eq!(out.slate.amt, 60_000_000_000);
    assert_eq!(out.slate.fee, 7_000_000);
    assert_eq!(out.slate.sigs.len(), 1);
    assert!(out.slate.sigs[0].part.is_none(), "sender hasn't signed yet at S1");
    assert!(out.slate.coms.is_none(), "S1 has no coms in compact slate");
    assert_eq!(out.slate.off, det(22), "offset matches input");
    assert_eq!(out.slate.feat, 0, "Plain kernel feature byte");
}

#[test]
fn sender_init_serializes_to_valid_v4_json() {
    let params = SenderInitParams {
        amount: 1_000_000_000,
        fee: 8_000_000,
        kernel_features: KernelFeatures::Plain { fee: 8_000_000 },
        sender_blind_excess: det(7),
        kernel_offset: det(8),
        kernel_nonce: det(9),
    };
    let out = sender_init_s1(&params).unwrap();
    let json = serialize_slate_v4(&out.slate).expect("serialize");
    assert!(json.contains(r#""sta":"S1""#));
    assert!(json.contains(r#""ver":"4:2""#));
    assert!(json.contains(r#""amt":"1000000000""#));
}

#[test]
fn slate_id_is_unique_per_call() {
    let params = SenderInitParams {
        amount: 1,
        fee: 1,
        kernel_features: KernelFeatures::Plain { fee: 1 },
        sender_blind_excess: det(1),
        kernel_offset: det(2),
        kernel_nonce: det(3),
    };
    let a = sender_init_s1(&params).unwrap();
    let b = sender_init_s1(&params).unwrap();
    assert_ne!(a.slate.id, b.slate.id, "each S1 gets a fresh UUID");
}

#[test]
fn nrd_kernel_emits_feat_args_with_relative_height() {
    let params = SenderInitParams {
        amount: 1,
        fee: 1,
        kernel_features: KernelFeatures::Nrd {
            fee: 1,
            relative_height: 1440,
        },
        sender_blind_excess: det(1),
        kernel_offset: det(2),
        kernel_nonce: det(3),
    };
    let out = sender_init_s1(&params).unwrap();
    assert_eq!(out.slate.feat, 3);
    let args = out.slate.feat_args.expect("NRD has feat_args");
    assert_eq!(args.lock_hgt, 1440);
}

#[test]
fn height_locked_emits_feat_args_with_lock_height() {
    let params = SenderInitParams {
        amount: 1,
        fee: 1,
        kernel_features: KernelFeatures::HeightLocked {
            fee: 1,
            lock_height: 500_000,
        },
        sender_blind_excess: det(1),
        kernel_offset: det(2),
        kernel_nonce: det(3),
    };
    let out = sender_init_s1(&params).unwrap();
    assert_eq!(out.slate.feat, 2);
    assert_eq!(out.slate.feat_args.unwrap().lock_hgt, 500_000);
}

#[test]
fn plain_kernel_omits_feat_args() {
    let params = SenderInitParams {
        amount: 1,
        fee: 1,
        kernel_features: KernelFeatures::Plain { fee: 1 },
        sender_blind_excess: det(1),
        kernel_offset: det(2),
        kernel_nonce: det(3),
    };
    let out = sender_init_s1(&params).unwrap();
    assert!(out.slate.feat_args.is_none());
}

#[test]
fn context_carries_secret_state_for_finalize() {
    let params = SenderInitParams {
        amount: 100,
        fee: 5,
        kernel_features: KernelFeatures::Plain { fee: 5 },
        sender_blind_excess: det(11),
        kernel_offset: det(22),
        kernel_nonce: det(33),
    };
    let out = sender_init_s1(&params).unwrap();
    assert_eq!(out.context.slate_id, out.slate.id);
    assert_eq!(out.context.sender_blind_excess, det(11));
    assert_eq!(out.context.kernel_nonce, det(33));
    assert_eq!(out.context.kernel_offset, det(22));
}

// =========================================================================
// Standard: receiver_round_s2
// =========================================================================

/// Build a complete S1 slate to feed into receiver tests.
fn build_s1(amount: u64, fee: u64, features: KernelFeatures) -> SenderInitOutput {
    sender_init_s1(&SenderInitParams {
        amount,
        fee,
        kernel_features: features,
        sender_blind_excess: det(11),
        kernel_offset: det(22),
        kernel_nonce: det(33),
    })
    .unwrap()
}

#[test]
fn receiver_round_produces_valid_s2() {
    let s1 = build_s1(60_000_000_000, 7_000_000, KernelFeatures::Plain { fee: 7_000_000 });

    let out = receiver_round_s2(&ReceiverRoundParams {
        s1_slate: s1.slate,
        receiver_output_blind: det(101),
        receiver_kernel_nonce: det(102),
        bp_rewind_nonce: det(103),
        bp_private_nonce: det(104),
        extended_private_key: None,
        output_path: None,
    })
    .expect("receiver round succeeds");

    assert_eq!(out.slate.sta, SlateStateV4::Standard2);
    assert_eq!(out.slate.sigs.len(), 2, "S2 has both sender + receiver sigs");
    assert!(out.slate.sigs[1].part.is_some(), "receiver added their partial");
    assert!(out.slate.sigs[0].part.is_none(), "sender hasn't signed yet");
    let coms = out.slate.coms.as_ref().expect("S2 has coms");
    assert_eq!(coms.len(), 1, "receiver's output is the only entry");
    assert_eq!(coms[0].f, 0, "Plain output");
    assert!(coms[0].p.is_some(), "rangeproof present");
}

#[test]
fn receiver_round_deterministic_output_is_seed_recoverable() {
    // End-to-end proof of the high-level receiver path
    // (`sign_incoming_send_slate`): derive the receiver blind from the wallet
    // ext key + output path, run the receiver round on its DETERMINISTIC
    // branch (ext key + path set), then prove the output it placed on the
    // slate recovers from the seed alone. Catches any path/blind mismatch in
    // the slate-builder threading (the unit round-trip only covers the helper).
    use crate::keychain::{derive_blind, SwitchCommitmentType};

    let amount = 60_000_000_000u64;
    let ext = [0x11u8; 64];
    let path = [0u32, 0, 7, 0];
    let blind = derive_blind(&ext, &path, amount, SwitchCommitmentType::Regular).unwrap();

    let s1 = build_s1(amount, 7_000_000, KernelFeatures::Plain { fee: 7_000_000 });
    let out = receiver_round_s2(&ReceiverRoundParams {
        s1_slate: s1.slate,
        receiver_output_blind: blind,
        receiver_kernel_nonce: det(102),
        bp_rewind_nonce: det(103), // ignored on the deterministic path
        bp_private_nonce: det(104),
        extended_private_key: Some(ext),
        output_path: Some(path),
    })
    .expect("receiver round succeeds");

    let coms = out.slate.coms.as_ref().expect("S2 has coms");
    let commitment = coms[0].c;
    let proof = coms[0].p.clone().expect("rangeproof present");

    let rec = crate::recover_output(&ext, &commitment, &proof)
        .unwrap()
        .expect("the receiver output MUST be recoverable from the seed alone");
    assert_eq!(rec.value, amount, "recovered amount");
    assert_eq!(rec.path, vec![0, 0, 7, 0], "recovered path matches output_path");
    assert_eq!(rec.path[2], 7, "spendable child index");
    // The context's stored rewind nonce is the deterministic one, not the
    // random bp_rewind_nonce we passed.
    assert_ne!(out.context.rewind_nonce, det(103));
}

#[test]
fn receiver_round_rejects_non_s1() {
    let mut s1_with_wrong_state =
        build_s1(100, 5, KernelFeatures::Plain { fee: 5 }).slate;
    s1_with_wrong_state.sta = SlateStateV4::Standard2; // not S1

    let result = receiver_round_s2(&ReceiverRoundParams {
        s1_slate: s1_with_wrong_state,
        receiver_output_blind: det(1),
        receiver_kernel_nonce: det(2),
        bp_rewind_nonce: det(3),
        bp_private_nonce: det(4),
        extended_private_key: None,
        output_path: None,
    });
    assert!(result.is_err());
}

// =========================================================================
// Standard: sender_finalize_s3 (full ceremony)
// =========================================================================

/// Run the full S1 → S2 → S3 ceremony with deterministic inputs.
/// Returns (final_aggregated_signature, final_s3_slate).
fn run_full_ceremony(
    amount: u64,
    fee: u64,
    features: KernelFeatures,
) -> ([u8; 64], SlateV4) {
    let init = sender_init_s1(&SenderInitParams {
        amount,
        fee,
        kernel_features: features,
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
        extended_private_key: None,
        output_path: None,
    })
    .unwrap();

    let s3 = sender_finalize_s3(&SenderFinalizeParams {
        s2_slate: s2.slate,
        sender_context: init.context,
    })
    .unwrap();

    (s3.final_signature, s3.slate)
}

#[test]
fn full_ceremony_produces_verifiable_aggregate_signature() {
    let (sig, slate) = run_full_ceremony(
        60_000_000_000,
        7_000_000,
        KernelFeatures::Plain { fee: 7_000_000 },
    );
    assert_eq!(sig.len(), 64);
    assert_eq!(slate.sta, SlateStateV4::Standard3);
    assert!(slate.sigs[0].part.is_some(), "sender's partial in S3");
    assert!(slate.sigs[1].part.is_some(), "receiver's partial in S3");

    // Verify the final aggregated signature against P_total = sender.xs + receiver.xs.
    let p_total = crate::schnorr::point_add(&slate.sigs[0].xs, &slate.sigs[1].xs).unwrap();
    let kernel_features = KernelFeatures::Plain { fee: 7_000_000 };
    let msg = kernel_features.sig_msg().unwrap();
    let signature = crate::schnorr::Signature::from_bytes(sig);
    assert!(crate::schnorr::verify(&signature, &msg, &p_total).unwrap());
}

#[test]
fn full_ceremony_works_with_nrd_kernel() {
    let (sig, slate) = run_full_ceremony(
        1_000_000_000,
        8_000_000,
        KernelFeatures::Nrd {
            fee: 8_000_000,
            relative_height: 1440,
        },
    );
    assert_eq!(slate.feat, 3);
    assert_eq!(slate.feat_args.unwrap().lock_hgt, 1440);

    // Verify final sig with the reconstructed kernel features.
    let p_total = crate::schnorr::point_add(&slate.sigs[0].xs, &slate.sigs[1].xs).unwrap();
    let kernel_features = KernelFeatures::Nrd {
        fee: 8_000_000,
        relative_height: 1440,
    };
    let msg = kernel_features.sig_msg().unwrap();
    let signature = crate::schnorr::Signature::from_bytes(sig);
    assert!(crate::schnorr::verify(&signature, &msg, &p_total).unwrap());
}

#[test]
fn finalize_rejects_non_s2() {
    let init = sender_init_s1(&SenderInitParams {
        amount: 100,
        fee: 5,
        kernel_features: KernelFeatures::Plain { fee: 5 },
        sender_blind_excess: det(11),
        kernel_offset: det(22),
        kernel_nonce: det(33),
    })
    .unwrap();

    // Pass an S1 (not S2) slate.
    let result = sender_finalize_s3(&SenderFinalizeParams {
        s2_slate: init.slate,
        sender_context: init.context,
    });
    assert!(result.is_err());
}

#[test]
fn finalize_rejects_tampered_receiver_partial() {
    let init = sender_init_s1(&SenderInitParams {
        amount: 100,
        fee: 5,
        kernel_features: KernelFeatures::Plain { fee: 5 },
        sender_blind_excess: det(11),
        kernel_offset: det(22),
        kernel_nonce: det(33),
    })
    .unwrap();
    let mut s2 = receiver_round_s2(&ReceiverRoundParams {
        s1_slate: init.slate,
        receiver_output_blind: det(101),
        receiver_kernel_nonce: det(102),
        bp_rewind_nonce: det(103),
        bp_private_nonce: det(104),
        extended_private_key: None,
        output_path: None,
    })
    .unwrap();

    // Flip a bit in the receiver's partial signature.
    let mut tampered = s2.slate.sigs[1].part.unwrap();
    tampered[0] ^= 0x01;
    s2.slate.sigs[1].part = Some(tampered);

    let result = sender_finalize_s3(&SenderFinalizeParams {
        s2_slate: s2.slate,
        sender_context: init.context,
    });
    assert!(result.is_err(), "finalize must reject tampered receiver partial");
}

#[test]
fn finalize_rejects_mismatched_slate_id() {
    let init_a = sender_init_s1(&SenderInitParams {
        amount: 100,
        fee: 5,
        kernel_features: KernelFeatures::Plain { fee: 5 },
        sender_blind_excess: det(11),
        kernel_offset: det(22),
        kernel_nonce: det(33),
    })
    .unwrap();
    let init_b = sender_init_s1(&SenderInitParams {
        amount: 200,
        fee: 6,
        kernel_features: KernelFeatures::Plain { fee: 6 },
        sender_blind_excess: det(44),
        kernel_offset: det(55),
        kernel_nonce: det(66),
    })
    .unwrap();
    let s2 = receiver_round_s2(&ReceiverRoundParams {
        s1_slate: init_a.slate,
        receiver_output_blind: det(101),
        receiver_kernel_nonce: det(102),
        bp_rewind_nonce: det(103),
        bp_private_nonce: det(104),
        extended_private_key: None,
        output_path: None,
    })
    .unwrap();

    // Try to finalize with the WRONG sender context (mismatched slate_id).
    let result = sender_finalize_s3(&SenderFinalizeParams {
        s2_slate: s2.slate,
        sender_context: init_b.context,
    });
    assert!(result.is_err(), "finalize must reject mismatched slate_id");
}

// =========================================================================
// Invoice: I1 / I2 / I3
// =========================================================================

#[test]
fn receiver_init_i1_produces_valid_invoice() {
    let out = receiver_init_i1(&ReceiverInitI1Params {
        amount: 1_000_000_000,
        fee: 8_000_000,
        kernel_features: KernelFeatures::Plain { fee: 8_000_000 },
        receiver_output_blind: det(101),
        receiver_kernel_nonce: det(102),
        bp_rewind_nonce: det(103),
        bp_private_nonce: det(104),
        extended_private_key: None,
        output_path: None,
        kernel_offset: [0u8; 32], // typical for invoices
    })
    .unwrap();

    assert_eq!(out.slate.sta, SlateStateV4::Invoice1);
    assert_eq!(out.slate.amt, 1_000_000_000);
    assert_eq!(out.slate.sigs.len(), 1, "I1 has only the receiver");
    assert!(out.slate.sigs[0].part.is_none(), "no signatures yet at I1");
    let coms = out.slate.coms.expect("I1 has the receiver's output");
    assert_eq!(coms.len(), 1);
    assert_eq!(coms[0].f, 0); // Plain output
    assert!(coms[0].p.is_some(), "rangeproof present from receiver");
}

#[test]
fn full_invoice_ceremony_produces_verifiable_aggregate_signature() {
    let amount = 1_000_000_000u64;
    let fee = 8_000_000u64;
    let features = KernelFeatures::Plain { fee };

    // Receiver creates the invoice.
    let i1 = receiver_init_i1(&ReceiverInitI1Params {
        amount,
        fee,
        kernel_features: features,
        receiver_output_blind: det(101),
        receiver_kernel_nonce: det(102),
        bp_rewind_nonce: det(103),
        bp_private_nonce: det(104),
        extended_private_key: None,
        output_path: None,
        kernel_offset: [0u8; 32],
    })
    .unwrap();

    // Sender responds.
    let i2 = sender_round_i2(&SenderRoundI2Params {
        i1_slate: i1.slate,
        sender_blind_excess: det(11),
        sender_kernel_nonce: det(33),
    })
    .unwrap();

    assert_eq!(i2.slate.sta, SlateStateV4::Invoice2);
    assert_eq!(i2.slate.sigs.len(), 2);
    assert!(i2.slate.sigs[0].part.is_none(), "receiver hasn't signed yet at I2");
    assert!(i2.slate.sigs[1].part.is_some(), "sender's partial in I2");

    // Receiver finalizes.
    let i3 = receiver_finalize_i3(&ReceiverFinalizeI3Params {
        i2_slate: i2.slate,
        receiver_context: i1.context,
    })
    .unwrap();

    assert_eq!(i3.slate.sta, SlateStateV4::Invoice3);
    assert!(i3.slate.sigs[0].part.is_some(), "receiver's partial in I3");
    assert!(i3.slate.sigs[1].part.is_some(), "sender's partial in I3");

    // Verify the final aggregate sig as a normal Schnorr against P_total.
    let p_total =
        crate::schnorr::point_add(&i3.slate.sigs[0].xs, &i3.slate.sigs[1].xs).unwrap();
    let msg = features.sig_msg().unwrap();
    let signature = crate::schnorr::Signature::from_bytes(i3.final_signature);
    assert!(crate::schnorr::verify(&signature, &msg, &p_total).unwrap());
}

#[test]
fn invoice_flow_rejects_non_i1_in_sender_round() {
    // Build an S1 (not I1) slate and try to feed it to sender_round_i2.
    let s1 = sender_init_s1(&SenderInitParams {
        amount: 1,
        fee: 1,
        kernel_features: KernelFeatures::Plain { fee: 1 },
        sender_blind_excess: det(11),
        kernel_offset: det(22),
        kernel_nonce: det(33),
    })
    .unwrap()
    .slate;
    let result = sender_round_i2(&SenderRoundI2Params {
        i1_slate: s1,
        sender_blind_excess: det(11),
        sender_kernel_nonce: det(33),
    });
    assert!(result.is_err());
}

#[test]
fn invoice_finalize_rejects_tampered_sender_partial() {
    let i1 = receiver_init_i1(&ReceiverInitI1Params {
        amount: 1_000_000_000,
        fee: 8_000_000,
        kernel_features: KernelFeatures::Plain { fee: 8_000_000 },
        receiver_output_blind: det(101),
        receiver_kernel_nonce: det(102),
        bp_rewind_nonce: det(103),
        bp_private_nonce: det(104),
        extended_private_key: None,
        output_path: None,
        kernel_offset: [0u8; 32],
    })
    .unwrap();

    let mut i2 = sender_round_i2(&SenderRoundI2Params {
        i1_slate: i1.slate,
        sender_blind_excess: det(11),
        sender_kernel_nonce: det(33),
    })
    .unwrap();

    // Tamper with the sender's partial scalar.
    let mut tampered = i2.slate.sigs[1].part.unwrap();
    tampered[32] ^= 0x01; // flip a bit in the scalar half
    i2.slate.sigs[1].part = Some(tampered);

    let result = receiver_finalize_i3(&ReceiverFinalizeI3Params {
        i2_slate: i2.slate,
        receiver_context: i1.context,
    });
    assert!(result.is_err());
}
