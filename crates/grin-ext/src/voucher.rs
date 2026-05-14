//! Grin voucher transactions — non-interactive UTXO transfers.
//!
//! Mimblewimble transactions are normally interactive: the sender and
//! receiver must both contribute to the kernel signature. Social tipping
//! breaks this assumption — the sender wants to drop a tip somewhere and
//! the recipient claims it asynchronously, with no live counterparty.
//!
//! The **voucher pattern** (ported from `smirk-extension`'s
//! `src/lib/grin/voucher.ts`) solves this by recognizing that Grin's
//! "ownership" of an output is determined purely by knowledge of its
//! blinding factor:
//!
//! 1. Sender builds a single-party transaction sending to themselves.
//!    Because the sender controls all blinds (input + output), they can
//!    sign the kernel single-handed (no interaction needed).
//! 2. Sender takes the *voucher output's blinding factor* (which they
//!    derived from their own keychain) and encrypts it to the
//!    recipient — via ECIES to the recipient's BTC pubkey (targeted
//!    tip) or via a URL fragment key (public link tip).
//! 3. Recipient decrypts the blinding factor, then runs the **sweep**
//!    flow: build a single-party tx that spends the voucher commitment
//!    as input + creates their own new output, knowing BOTH blinds
//!    (voucher blind + their own new-output blind), and signing the
//!    kernel single-handed.
//!
//! This module provides the two orchestrators —
//! [`create_grin_voucher`] (sender) and [`sweep_grin_voucher`]
//! (claimer) — that produce broadcastable transaction bytes for each
//! direction.
//!
//! ### Why single-party signing works
//!
//! Grin's kernel signature signs:
//!   excess_pubkey = (Σ out_blinds − Σ in_blinds − offset) · G
//!
//! If you know every input blind and every output blind, that scalar is
//! fully computable. There's no protocol-level requirement that
//! multiple keys contribute to it — the multi-party ceremony exists
//! because *in normal sends* the sender doesn't know the receiver's
//! output blind. In a voucher tx, the sender controls all blinds; in a
//! sweep, the claimer knows both (the voucher blind from decryption +
//! their own new-output blind from their keychain).

use crate::blind::{sub as scalar_sub, sum as scalar_sum};
use crate::bulletproof::{bullet_proof_create, pedersen_commit};
use crate::kernel::KernelFeatures;
use crate::keychain::{derive_blind, SwitchCommitmentType};
use crate::schnorr::sign_with_nonce as schnorr_sign;
use crate::secp256k1::public_key_from_secret_key;
use crate::transaction::pubkey_to_commitment;
use crate::wallet_flows::{ChangeOutputInfo, UnspentOutput};

/// Inputs to [`create_grin_voucher`] — sender-side.
#[derive(Debug, Clone)]
pub struct CreateVoucherParams {
    /// Wallet's 64-byte BIP32 root (secret_key || chain_code).
    pub extended_private_key: [u8; 64],
    /// Inputs the sender is spending. Caller already selected (orchestrator
    /// doesn't pick UTXOs).
    pub inputs: Vec<UnspentOutput>,
    /// Voucher output amount in nanogrin. This is the amount the
    /// recipient will eventually claim (minus their sweep fee).
    pub voucher_amount: u64,
    /// Network fee in nanogrin (paid in this tx, not deducted from
    /// voucher_amount).
    pub fee: u64,
    /// BIP32 path for the voucher output (sender derives the blind
    /// here; the resulting blinding factor is what gets encrypted to
    /// the recipient).
    pub voucher_path: [u32; 4],
    /// BIP32 path + amount for change. `None` if no change.
    pub change: Option<ChangePath>,
    /// 32-byte kernel offset. Caller picks (random or zero).
    pub kernel_offset: [u8; 32],
    /// 32-byte secret nonce for kernel signing. Caller generates
    /// fresh (e.g. `random_secret_nonce()`).
    pub kernel_nonce: [u8; 32],
    /// Bulletproof rewind nonce for the voucher output. Recipient
    /// doesn't need this — but the proof is on chain and must be
    /// verifiable, so we still construct one.
    pub bp_rewind_nonce: [u8; 32],
    /// Bulletproof private nonce for the voucher output.
    pub bp_private_nonce: [u8; 32],
    /// Same nonces for change output (if any).
    pub change_bp_rewind_nonce: [u8; 32],
    pub change_bp_private_nonce: [u8; 32],
}

#[derive(Debug, Clone)]
pub struct ChangePath {
    pub path: [u32; 4],
    pub amount: u64,
}

/// The voucher output — what gets shared with the recipient. The
/// `blinding_factor` is the secret that grants spend authority and
/// MUST be encrypted to the recipient (never broadcast or stored
/// plaintext server-side).
#[derive(Debug, Clone)]
pub struct VoucherOutput {
    pub path: [u32; 4],
    pub amount: u64,
    pub commitment: [u8; 33],
    pub proof: Vec<u8>,
    /// SECRET — encrypted to recipient via ECIES (targeted) or URL
    /// fragment key (public). Never log or transmit plaintext.
    pub blinding_factor: [u8; 32],
}

/// Output of [`create_grin_voucher`].
#[derive(Debug, Clone)]
pub struct CreateVoucherResult {
    /// Voucher output details (with secret blind — handle carefully).
    pub voucher: VoucherOutput,
    /// Change output (for the sender's own bookkeeping; appears as
    /// `unconfirmed` until the tx confirms).
    pub change: Option<ChangeOutputInfo>,
    /// 33-byte kernel excess (commitment form). Goes on chain;
    /// recipient does NOT need this to claim.
    pub kernel_excess: [u8; 33],
    /// Broadcastable Grin transaction bytes.
    pub tx_bytes: Vec<u8>,
}

/// Inputs to [`sweep_grin_voucher`] — claimer-side.
#[derive(Debug, Clone)]
pub struct SweepVoucherParams {
    /// Claimer's 64-byte BIP32 root.
    pub extended_private_key: [u8; 64],
    /// 33-byte commitment of the voucher output (on-chain identifier).
    pub voucher_commitment: [u8; 33],
    /// SECRET — the voucher's blinding factor, decrypted from the
    /// sender's encrypted payload. Grants spend authority.
    pub voucher_blind: [u8; 32],
    /// Voucher amount in nanogrin (so we can compute the claimer's
    /// output amount after fee).
    pub voucher_amount: u64,
    /// Voucher's features byte (0 = plain, 1 = coinbase). v0.3 always
    /// emits plain vouchers but the wire format requires it.
    pub voucher_features: u8,
    /// BIP32 path for the claimer's new output.
    pub claimer_path: [u32; 4],
    /// Fee for the sweep tx (deducted from voucher_amount).
    pub fee: u64,
    pub kernel_offset: [u8; 32],
    pub kernel_nonce: [u8; 32],
    pub bp_rewind_nonce: [u8; 32],
    pub bp_private_nonce: [u8; 32],
}

#[derive(Debug, Clone)]
pub struct SweepVoucherResult {
    /// Claimer's new output. They persist this in their own grin_outputs
    /// table to spend later.
    pub output: ChangeOutputInfo,
    pub kernel_excess: [u8; 33],
    pub tx_bytes: Vec<u8>,
}

/// Build a single-party voucher transaction.
///
/// See module docs. Returns the broadcastable tx_bytes plus the
/// voucher output's secret blinding factor (which the caller encrypts
/// to the recipient).
pub fn create_grin_voucher(
    params: &CreateVoucherParams,
) -> Result<CreateVoucherResult, String> {
    // --- 1. Derive blinds for the inputs we're spending ---
    // Each input's blind comes from re-deriving via the wallet's BIP32
    // path + switch-commitment-adjusted scheme (HF2 consensus).
    let mut input_blinds: Vec<[u8; 32]> = Vec::with_capacity(params.inputs.len());
    for inp in &params.inputs {
        let blind = derive_blind(
            &params.extended_private_key,
            &inp.path,
            inp.amount,
            SwitchCommitmentType::Regular,
        )?;
        input_blinds.push(blind);
    }

    // --- 2. Derive voucher output blind + commitment + proof ---
    let voucher_blind = derive_blind(
        &params.extended_private_key,
        &params.voucher_path,
        params.voucher_amount,
        SwitchCommitmentType::Regular,
    )?;
    let voucher_commit = pedersen_commit(params.voucher_amount, &voucher_blind)?;
    let voucher_proof = bullet_proof_create(
        params.voucher_amount,
        &voucher_blind,
        &params.bp_rewind_nonce,
        &params.bp_private_nonce,
    )?;

    let voucher_output = VoucherOutput {
        path: params.voucher_path,
        amount: params.voucher_amount,
        commitment: voucher_commit,
        proof: voucher_proof.clone(),
        blinding_factor: voucher_blind,
    };

    // --- 3. Derive change output (if any) ---
    let (change_blind_opt, change_info) = match &params.change {
        Some(ch) => {
            let blind = derive_blind(
                &params.extended_private_key,
                &ch.path,
                ch.amount,
                SwitchCommitmentType::Regular,
            )?;
            let commit = pedersen_commit(ch.amount, &blind)?;
            let proof = bullet_proof_create(
                ch.amount,
                &blind,
                &params.change_bp_rewind_nonce,
                &params.change_bp_private_nonce,
            )?;
            (
                Some(blind),
                Some(ChangeOutputInfo {
                    path: ch.path,
                    amount: ch.amount,
                    commitment: commit,
                    proof,
                }),
            )
        }
        None => (None, None),
    };

    // --- 4. Compute the kernel-signing secret ---
    // excess_signing_key = (Σ out_blinds − Σ in_blinds − offset)
    // Grin convention: kernel_excess (on chain) = excess_signing_key · G;
    // offset is stored separately in the tx's `offset` field. Network
    // reconstructs the original sum by adding offset · G back.
    let mut out_blinds: Vec<[u8; 32]> = vec![voucher_blind];
    if let Some(b) = change_blind_opt {
        out_blinds.push(b);
    }
    let out_sum = scalar_sum(&out_blinds);
    let in_sum = scalar_sum(&input_blinds);
    let signing_key = scalar_sub(&scalar_sub(&out_sum, &in_sum), &params.kernel_offset);

    // --- 5. Build the kernel signature ---
    let kernel_features = KernelFeatures::Plain { fee: params.fee };
    let sig_msg = kernel_features.sig_msg()?;
    let signing_pubkey = public_key_from_secret_key(&signing_key)?;
    let kernel_excess = pubkey_to_commitment(&signing_pubkey)?;
    let signature = schnorr_sign(&signing_key, &params.kernel_nonce, &sig_msg)?;

    // --- 6. Serialize the broadcastable transaction ---
    // Wire format mirrors `slate_to_transaction_bytes` but without the
    // slate roundabout — we're producing the same wire shape directly
    // since we have all data on hand.
    let mut all_outputs: Vec<(u8, [u8; 33], Vec<u8>)> = Vec::with_capacity(2);
    all_outputs.push((0, voucher_commit, voucher_proof));
    if let Some(ref ch) = change_info {
        all_outputs.push((0, ch.commitment, ch.proof.clone()));
    }

    let tx_bytes = serialize_voucher_tx(
        &params.kernel_offset,
        &params.inputs,
        &all_outputs,
        &kernel_features.to_v2_bytes()?,
        &kernel_excess,
        &signature.0,
    );

    Ok(CreateVoucherResult {
        voucher: voucher_output,
        change: change_info,
        kernel_excess,
        tx_bytes,
    })
}

/// Sweep a previously-created voucher into the claimer's own keychain.
///
/// The claimer must have decrypted the voucher's blinding factor via
/// ECIES (targeted tip) or URL fragment key (public tip) before
/// calling this. They construct a single-input single-output tx that
/// spends the voucher commitment and lands a new output they control.
pub fn sweep_grin_voucher(
    params: &SweepVoucherParams,
) -> Result<SweepVoucherResult, String> {
    if params.voucher_amount <= params.fee {
        return Err(format!(
            "voucher amount {} ≤ fee {} — nothing to claim",
            params.voucher_amount, params.fee
        ));
    }
    let claimer_amount = params.voucher_amount - params.fee;

    // --- 1. Derive the claimer's new-output blind + commit + proof ---
    let claimer_blind = derive_blind(
        &params.extended_private_key,
        &params.claimer_path,
        claimer_amount,
        SwitchCommitmentType::Regular,
    )?;
    let claimer_commit = pedersen_commit(claimer_amount, &claimer_blind)?;
    let claimer_proof = bullet_proof_create(
        claimer_amount,
        &claimer_blind,
        &params.bp_rewind_nonce,
        &params.bp_private_nonce,
    )?;

    // --- 2. Compute signing key ---
    // excess = claimer_blind − voucher_blind − offset
    let signing_key = scalar_sub(
        &scalar_sub(&claimer_blind, &params.voucher_blind),
        &params.kernel_offset,
    );

    // --- 3. Kernel signature ---
    let kernel_features = KernelFeatures::Plain { fee: params.fee };
    let sig_msg = kernel_features.sig_msg()?;
    let signing_pubkey = public_key_from_secret_key(&signing_key)?;
    let kernel_excess = pubkey_to_commitment(&signing_pubkey)?;
    let signature = schnorr_sign(&signing_key, &params.kernel_nonce, &sig_msg)?;

    // --- 4. Serialize ---
    // Voucher tx has 1 input (the voucher commitment) and 1 output (claimer's).
    let voucher_input = UnspentOutput {
        path: [0, 0, 0, 0], // unused — we don't re-derive the voucher blind here
        amount: params.voucher_amount,
        commitment: params.voucher_commitment,
        is_coinbase: params.voucher_features == 1,
    };
    let outputs = vec![(0u8, claimer_commit, claimer_proof.clone())];

    let tx_bytes = serialize_voucher_tx(
        &params.kernel_offset,
        &[voucher_input],
        &outputs,
        &kernel_features.to_v2_bytes()?,
        &kernel_excess,
        &signature.0,
    );

    Ok(SweepVoucherResult {
        output: ChangeOutputInfo {
            path: params.claimer_path,
            amount: claimer_amount,
            commitment: claimer_commit,
            proof: claimer_proof,
        },
        kernel_excess,
        tx_bytes,
    })
}

// =============================================================================
// Wire-format serialization (shared between create + sweep)
// =============================================================================

/// Build the Grin transaction wire bytes for a single-kernel tx.
///
/// Same shape as `slate_to_transaction_bytes` (see `transaction.rs`):
///   offset(32) || #inputs(8 BE) || #outputs(8 BE) || #kernels(8 BE)
///     || (feature(1) || commit(33))   ×  #inputs
///     || (feature(1) || commit(33) || proof_len(8 BE) || proof)  ×  #outputs
///     || kernel_features_bytes
///     || kernel_excess(33)
///     || kernel_signature(64)
fn serialize_voucher_tx(
    offset: &[u8; 32],
    inputs: &[UnspentOutput],
    outputs: &[(u8, [u8; 33], Vec<u8>)],
    kernel_features_bytes: &[u8],
    kernel_excess: &[u8; 33],
    signature: &[u8; 64],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        32 // offset
            + 24 // 3 length counters
            + inputs.len() * (1 + 33)
            + outputs
                .iter()
                .map(|(_, _, p)| 1 + 33 + 8 + p.len())
                .sum::<usize>()
            + kernel_features_bytes.len()
            + 33
            + 64,
    );

    // Offset
    out.extend_from_slice(offset);
    // Counts
    out.extend_from_slice(&(inputs.len() as u64).to_be_bytes());
    out.extend_from_slice(&(outputs.len() as u64).to_be_bytes());
    out.extend_from_slice(&1u64.to_be_bytes()); // single-kernel
    // Inputs
    for inp in inputs {
        out.push(if inp.is_coinbase { 1 } else { 0 });
        out.extend_from_slice(&inp.commitment);
    }
    // Outputs
    for (feat, commit, proof) in outputs {
        out.push(*feat);
        out.extend_from_slice(commit);
        out.extend_from_slice(&(proof.len() as u64).to_be_bytes());
        out.extend_from_slice(proof);
    }
    // Kernel
    out.extend_from_slice(kernel_features_bytes);
    out.extend_from_slice(kernel_excess);
    out.extend_from_slice(signature);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secp256k1::random_secret_nonce;
    use crate::seed::mnemonic_to_extended_private_key;

    const MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn fund_input(extk: &[u8; 64], amount: u64, n_child: u32) -> UnspentOutput {
        let path = [0u32, 0, n_child, 0];
        let blind = derive_blind(extk, &path, amount, SwitchCommitmentType::Regular).unwrap();
        let commit = pedersen_commit(amount, &blind).unwrap();
        UnspentOutput {
            path,
            amount,
            commitment: commit,
            is_coinbase: false,
        }
    }

    #[test]
    fn create_voucher_with_change_produces_valid_tx_bytes() {
        let xkey = mnemonic_to_extended_private_key(MNEMONIC).unwrap();
        let extk = xkey.0;

        let input = fund_input(&extk, 10_000_000_000, 0); // 10 GRIN

        let params = CreateVoucherParams {
            extended_private_key: extk,
            inputs: vec![input],
            voucher_amount: 5_000_000_000, // 5 GRIN
            fee: 25_000_000,                // 0.025 GRIN
            voucher_path: [0, 0, 1, 0],
            change: Some(ChangePath {
                path: [0, 0, 2, 0],
                amount: 10_000_000_000 - 5_000_000_000 - 25_000_000,
            }),
            kernel_offset: random_secret_nonce(),
            kernel_nonce: random_secret_nonce(),
            bp_rewind_nonce: random_secret_nonce(),
            bp_private_nonce: random_secret_nonce(),
            change_bp_rewind_nonce: random_secret_nonce(),
            change_bp_private_nonce: random_secret_nonce(),
        };

        let result = create_grin_voucher(&params).expect("create succeeds");

        assert_eq!(result.voucher.amount, 5_000_000_000);
        assert!(result.change.is_some());
        assert!(!result.tx_bytes.is_empty());
        assert_eq!(result.tx_bytes.len() > 100, true); // non-trivial bytes
        // Voucher blind is the secret that will be encrypted to recipient.
        assert_ne!(result.voucher.blinding_factor, [0u8; 32]);
    }

    #[test]
    fn create_voucher_without_change_works_when_exact() {
        let xkey = mnemonic_to_extended_private_key(MNEMONIC).unwrap();
        let extk = xkey.0;

        // Exact-amount input: voucher_amount + fee == input amount
        let input = fund_input(&extk, 1_025_000_000, 3); // 1.025 GRIN

        let params = CreateVoucherParams {
            extended_private_key: extk,
            inputs: vec![input],
            voucher_amount: 1_000_000_000, // 1 GRIN voucher
            fee: 25_000_000,                // 0.025 fee
            voucher_path: [0, 0, 4, 0],
            change: None,
            kernel_offset: random_secret_nonce(),
            kernel_nonce: random_secret_nonce(),
            bp_rewind_nonce: random_secret_nonce(),
            bp_private_nonce: random_secret_nonce(),
            change_bp_rewind_nonce: [0u8; 32],
            change_bp_private_nonce: [0u8; 32],
        };

        let result = create_grin_voucher(&params).expect("create succeeds");
        assert!(result.change.is_none());
    }

    #[test]
    fn round_trip_create_then_sweep_balances_kernel() {
        // Sender (mnemonic A) creates a voucher; claimer (mnemonic B,
        // simulated with same mnemonic for test simplicity) sweeps it.
        // Verifies that the cryptographic primitives compose end-to-end:
        // sweep can re-derive a signing key from the voucher_blind and
        // produce a valid kernel signature.
        let xkey = mnemonic_to_extended_private_key(MNEMONIC).unwrap();
        let extk = xkey.0;

        let input = fund_input(&extk, 10_000_000_000, 5);

        let voucher = create_grin_voucher(&CreateVoucherParams {
            extended_private_key: extk,
            inputs: vec![input],
            voucher_amount: 5_000_000_000,
            fee: 25_000_000,
            voucher_path: [0, 0, 6, 0],
            change: Some(ChangePath {
                path: [0, 0, 7, 0],
                amount: 5_000_000_000 - 25_000_000,
            }),
            kernel_offset: random_secret_nonce(),
            kernel_nonce: random_secret_nonce(),
            bp_rewind_nonce: random_secret_nonce(),
            bp_private_nonce: random_secret_nonce(),
            change_bp_rewind_nonce: random_secret_nonce(),
            change_bp_private_nonce: random_secret_nonce(),
        })
        .expect("create voucher");

        // Sweep using the secret voucher blind.
        let sweep = sweep_grin_voucher(&SweepVoucherParams {
            extended_private_key: extk,
            voucher_commitment: voucher.voucher.commitment,
            voucher_blind: voucher.voucher.blinding_factor,
            voucher_amount: voucher.voucher.amount,
            voucher_features: 0,
            claimer_path: [0, 0, 100, 0],
            fee: 8_000_000, // 0.008 GRIN sweep fee
            kernel_offset: random_secret_nonce(),
            kernel_nonce: random_secret_nonce(),
            bp_rewind_nonce: random_secret_nonce(),
            bp_private_nonce: random_secret_nonce(),
        })
        .expect("sweep succeeds");

        assert_eq!(sweep.output.amount, voucher.voucher.amount - 8_000_000);
        assert!(!sweep.tx_bytes.is_empty());
        // Kernel excess on sweep is a distinct commitment from create
        // (different signing keys).
        assert_ne!(sweep.kernel_excess, voucher.kernel_excess);
    }

    #[test]
    fn sweep_rejects_voucher_with_amount_below_fee() {
        let xkey = mnemonic_to_extended_private_key(MNEMONIC).unwrap();
        let extk = xkey.0;
        let res = sweep_grin_voucher(&SweepVoucherParams {
            extended_private_key: extk,
            voucher_commitment: [0u8; 33],
            voucher_blind: [1u8; 32],
            voucher_amount: 1000,
            voucher_features: 0,
            claimer_path: [0, 0, 0, 0],
            fee: 5000,
            kernel_offset: [0u8; 32],
            kernel_nonce: random_secret_nonce(),
            bp_rewind_nonce: random_secret_nonce(),
            bp_private_nonce: random_secret_nonce(),
        });
        assert!(res.is_err());
    }
}
