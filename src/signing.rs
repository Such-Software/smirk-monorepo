//! Transaction signing - construct and sign Monero transactions.
//!
//! This module handles the core transaction construction flow:
//! 1. Parse owned outputs from LWS `get_unspent_outs`
//! 2. Parse decoy ring members from LWS `get_random_outs`
//! 3. Combine into `OutputWithDecoys`
//! 4. Build `SignableTransaction` with destination and change
//! 5. Sign with the spend key

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use monero_oxide::ed25519::{CompressedPoint, Point, Scalar, Commitment};
use monero_oxide::ringct::{RctType, clsag::Decoys};
use monero_oxide::transaction::Transaction;
use monero_wallet::{
    OutputWithDecoys,
    address::{MoneroAddress, Network},
    interface::FeeRate,
    send::{Change, SignableTransaction},
};

use crate::output::{derive_key_offset, derive_commitment_mask};
use crate::result::WasmResult;

// ============================================================================
// Input types from LWS
// ============================================================================

/// An unspent output from LWS `get_unspent_outs`.
#[derive(Debug, Clone, Deserialize)]
pub struct LwsOutput {
    /// Amount in atomic units
    pub amount: u64,
    /// Output public key (hex)
    pub public_key: String,
    /// Transaction public key (hex)
    pub tx_pub_key: String,
    /// Output index within transaction
    pub index: u32,
    /// Global output index on blockchain
    pub global_index: u64,
    /// Block height
    pub height: u64,
    /// RingCT data (hex) - commitment
    #[serde(default)]
    pub rct: String,
}

/// A random output for decoy selection from LWS `get_random_outs`.
#[derive(Debug, Clone, Deserialize)]
pub struct LwsDecoy {
    /// Global output index
    pub global_index: u64,
    /// Output public key (hex)
    pub public_key: String,
    /// RingCT commitment (hex)
    pub rct: String,
}

/// Input for transaction: owned output + decoys.
#[derive(Debug, Clone, Deserialize)]
pub struct TxInput {
    /// The owned output being spent
    pub output: LwsOutput,
    /// Ring members (decoys) for this input
    pub decoys: Vec<LwsDecoy>,
}

/// Transaction destination.
#[derive(Debug, Clone, Deserialize)]
pub struct TxDestination {
    /// Recipient address
    pub address: String,
    /// Amount in atomic units
    pub amount: u64,
}

/// Parameters for building a transaction.
#[derive(Debug, Clone, Deserialize)]
pub struct TxParams {
    /// Inputs (owned outputs with decoys)
    pub inputs: Vec<TxInput>,
    /// Destinations (can be multiple)
    pub destinations: Vec<TxDestination>,
    /// Change address
    pub change_address: String,
    /// Fee per byte
    pub fee_per_byte: u64,
    /// Fee mask for rounding
    pub fee_mask: u64,
    /// Private view key (hex)
    pub view_key: String,
    /// Private spend key (hex)
    pub spend_key: String,
    /// Network: "mainnet", "testnet", or "stagenet"
    #[serde(default = "default_network")]
    pub network: String,
}

fn default_network() -> String {
    "mainnet".to_string()
}

// ============================================================================
// Output types
// ============================================================================

/// Result of transaction signing.
#[derive(Debug, Clone, Serialize)]
pub struct SignedTx {
    /// Signed transaction as hex
    pub tx_hex: String,
    /// Transaction hash
    pub tx_hash: String,
    /// Fee paid
    pub fee: u64,
}

// ============================================================================
// Helper functions
// ============================================================================

/// Parse a 32-byte hex string into a fixed array.
fn parse_hex_32(s: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(s).map_err(|e| format!("Invalid hex: {}", e))?;
    if bytes.len() != 32 {
        return Err(format!("Expected 32 bytes, got {}", bytes.len()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

/// Parse a point from hex.
fn parse_point(s: &str) -> Result<Point, String> {
    let bytes = parse_hex_32(s)?;
    CompressedPoint::from(bytes)
        .decompress()
        .ok_or_else(|| "Invalid point".to_string())
}

/// Parse commitment from LWS rct field.
/// LWS returns commitment as 64 hex chars (32 bytes).
fn parse_commitment_point(rct: &str) -> Result<Point, String> {
    // LWS returns just the commitment point (32 bytes = 64 hex chars)
    if rct.len() < 64 {
        return Err(format!("RCT too short: {} chars", rct.len()));
    }
    parse_point(&rct[..64])
}

/// Build OutputWithDecoys from LWS data.
///
/// This constructs the monero-oxide OutputWithDecoys by serializing
/// OutputData and Decoys in the format expected by OutputWithDecoys::read().
fn build_output_with_decoys(
    input: &TxInput,
    view_key: &[u8; 32],
) -> Result<OutputWithDecoys, String> {
    let output = &input.output;

    // Parse the output public key
    let output_key = parse_point(&output.public_key)?;

    // Parse transaction public key
    let tx_pub_key = parse_hex_32(&output.tx_pub_key)?;

    // Derive key_offset from view_key and tx_pub_key
    let key_offset = derive_key_offset(view_key, &tx_pub_key, output.index as usize)
        .map_err(|e| e.to_string())?;

    // Derive commitment mask
    let mask = derive_commitment_mask(view_key, &tx_pub_key, output.index as usize)
        .map_err(|e| e.to_string())?;

    // Create commitment with mask and amount
    let commitment = Commitment::new(mask, output.amount);

    // Build the ring: combine real output with decoys, then sort by global_index
    let mut ring_members: Vec<(u64, [Point; 2])> = Vec::with_capacity(16);

    // Add the real output
    ring_members.push((output.global_index, [output_key, commitment.commit()]));

    // Add decoys
    for decoy in &input.decoys {
        let decoy_key = parse_point(&decoy.public_key)?;
        let decoy_commitment = parse_commitment_point(&decoy.rct)?;
        ring_members.push((decoy.global_index, [decoy_key, decoy_commitment]));
    }

    // Sort by global_index
    ring_members.sort_by_key(|(idx, _)| *idx);

    // Find signer index after sorting
    let signer_index = ring_members
        .iter()
        .position(|(idx, _)| *idx == output.global_index)
        .ok_or("Real output not found in ring")?;

    // Convert absolute indices to offsets
    let mut offsets = Vec::with_capacity(ring_members.len());
    offsets.push(ring_members[0].0);
    for i in 1..ring_members.len() {
        offsets.push(ring_members[i].0 - ring_members[i - 1].0);
    }

    // Extract ring points
    let ring: Vec<[Point; 2]> = ring_members.into_iter().map(|(_, pts)| pts).collect();

    // Create Decoys struct
    let decoys = Decoys::new(offsets, signer_index as u8, ring)
        .ok_or("Failed to create Decoys")?;

    // Serialize OutputData + Decoys in the format OutputWithDecoys::read expects
    let mut serialized = Vec::with_capacity(256);

    // OutputData: key (32) || key_offset (32) || commitment (mask:32 + amount:8)
    serialized.extend_from_slice(&output_key.compress().to_bytes());
    key_offset.write(&mut serialized).map_err(|e| format!("Write key_offset: {:?}", e))?;
    commitment.write(&mut serialized).map_err(|e| format!("Write commitment: {:?}", e))?;

    // Decoys
    decoys.write(&mut serialized).map_err(|e| format!("Write decoys: {:?}", e))?;

    // Read back as OutputWithDecoys
    OutputWithDecoys::read(&mut serialized.as_slice())
        .map_err(|e| format!("Read OutputWithDecoys: {:?}", e))
}

// ============================================================================
// Public API
// ============================================================================

/// Build and sign a transaction.
///
/// This takes LWS-format data and produces a signed transaction ready for broadcast.
///
/// # Arguments
/// * `params_json` - JSON string containing `TxParams`
///
/// # Returns
/// JSON with `SignedTx` or error.
#[wasm_bindgen]
pub fn sign_transaction(params_json: &str) -> String {
    match sign_transaction_inner(params_json) {
        Ok(tx) => WasmResult::ok_json(&tx),
        Err(e) => WasmResult::err(&e),
    }
}

fn sign_transaction_inner(params_json: &str) -> Result<SignedTx, String> {
    // Parse parameters
    let params: TxParams = serde_json::from_str(params_json)
        .map_err(|e| format!("Failed to parse params: {}", e))?;

    // Validate inputs
    if params.inputs.is_empty() {
        return Err("No inputs provided".to_string());
    }
    if params.destinations.is_empty() {
        return Err("No destinations provided".to_string());
    }

    // Parse keys
    let view_key = parse_hex_32(&params.view_key)?;
    let spend_key_bytes = parse_hex_32(&params.spend_key)?;

    let spend_scalar = Scalar::from(
        subtle::CtOption::<curve25519_dalek::Scalar>::from(
            curve25519_dalek::Scalar::from_canonical_bytes(spend_key_bytes)
        ).unwrap()
    );

    // Check ring size (should be 16 for current Monero)
    for (i, input) in params.inputs.iter().enumerate() {
        if input.decoys.len() != 15 {
            return Err(format!(
                "Input {} has {} decoys, expected 15 (ring size 16)",
                i,
                input.decoys.len()
            ));
        }
    }

    // Build OutputWithDecoys for each input
    let mut inputs_with_decoys = Vec::with_capacity(params.inputs.len());
    for input in &params.inputs {
        let owd = build_output_with_decoys(input, &view_key)?;
        inputs_with_decoys.push(owd);
    }

    // Determine network from first address (or param)
    let network = match params.network.as_str() {
        "mainnet" => Network::Mainnet,
        "testnet" => Network::Testnet,
        "stagenet" => Network::Stagenet,
        _ => return Err(format!("Unknown network: {}", params.network)),
    };

    // Parse destination addresses
    let mut payments: Vec<(MoneroAddress, u64)> = Vec::new();
    for dest in &params.destinations {
        let addr = MoneroAddress::from_str(network, &dest.address)
            .map_err(|e| format!("Invalid address '{}': {:?}", dest.address, e))?;
        payments.push((addr, dest.amount));
    }

    // Parse change address
    let change_addr = MoneroAddress::from_str(network, &params.change_address)
        .map_err(|e| format!("Invalid change address '{}': {:?}", params.change_address, e))?;

    // Create fee rate
    let fee_rate = FeeRate::new(params.fee_per_byte, params.fee_mask)
        .ok_or("Invalid fee rate")?;

    // Create outgoing view key (32 bytes of zeros for now - this is used for
    // deterministic output key generation, not critical for basic signing)
    let outgoing_view_key = Zeroizing::new([0u8; 32]);

    // Build SignableTransaction
    // Note: Change::fingerprintable is used as we don't have the full view pair
    let change = Change::fingerprintable(Some(change_addr));

    let signable = SignableTransaction::new(
        RctType::ClsagBulletproofPlus,
        outgoing_view_key,
        inputs_with_decoys,
        payments,
        change,
        vec![], // no extra data
        fee_rate,
    ).map_err(|e| format!("Failed to create signable tx: {:?}", e))?;

    // Get the fee before signing (sign consumes the transaction)
    let fee = signable.necessary_fee();

    // Sign the transaction
    let mut rng = rand_core::OsRng;
    let spend_key_zeroizing = Zeroizing::new(spend_scalar);
    let tx: Transaction = signable.sign(&mut rng, &spend_key_zeroizing)
        .map_err(|e| format!("Failed to sign: {:?}", e))?;

    // Serialize transaction
    let tx_bytes = tx.serialize();
    let tx_hex = hex::encode(&tx_bytes);
    let tx_hash = hex::encode(tx.hash());

    Ok(SignedTx {
        tx_hex,
        tx_hash,
        fee,
    })
}

/// Estimate the fee for a transaction.
///
/// # Arguments
/// * `num_inputs` - Number of inputs
/// * `num_outputs` - Number of outputs (including change)
/// * `fee_per_byte` - Fee per byte from LWS
/// * `fee_mask` - Fee mask for rounding
///
/// # Returns
/// Estimated fee in atomic units.
#[wasm_bindgen]
pub fn estimate_fee(
    num_inputs: u32,
    num_outputs: u32,
    fee_per_byte: u64,
    fee_mask: u64,
) -> String {
    // Rough transaction size estimation
    // Based on monero-wallet-cli estimates:
    // - Base: ~100 bytes
    // - Per input: ~2500 bytes (ring size 16, CLSAG)
    // - Per output: ~100 bytes
    // - Bulletproof+: ~700 bytes for 2 outputs, scales logarithmically

    let base_size: u64 = 100;
    let per_input: u64 = 2500;
    let per_output: u64 = 100;

    // Bulletproof+ size approximation
    let bp_size: u64 = if num_outputs <= 2 {
        700
    } else if num_outputs <= 4 {
        900
    } else if num_outputs <= 8 {
        1100
    } else {
        1300
    };

    let estimated_size = base_size
        + (num_inputs as u64 * per_input)
        + (num_outputs as u64 * per_output)
        + bp_size;

    let fee = estimated_size * fee_per_byte;

    // Round up to fee_mask
    let rounded_fee = if fee_mask > 0 {
        ((fee + fee_mask - 1) / fee_mask) * fee_mask
    } else {
        fee
    };

    WasmResult::ok(rounded_fee)
}

/// Derive key image for an output (useful for spend detection).
///
/// # Arguments
/// * `view_key` - Private view key (hex)
/// * `spend_key` - Private spend key (hex)
/// * `tx_pub_key` - Transaction public key (hex)
/// * `output_index` - Output index within transaction
/// * `output_key` - Output public key (hex)
///
/// # Returns
/// Key image as hex string.
#[wasm_bindgen]
pub fn derive_output_key_image(
    view_key: &str,
    spend_key: &str,
    tx_pub_key: &str,
    output_index: u32,
    output_key: &str,
) -> String {
    match derive_output_key_image_inner(view_key, spend_key, tx_pub_key, output_index, output_key) {
        Ok(ki) => WasmResult::ok(ki),
        Err(e) => WasmResult::err(&e),
    }
}

fn derive_output_key_image_inner(
    view_key: &str,
    spend_key: &str,
    tx_pub_key: &str,
    output_index: u32,
    output_key: &str,
) -> Result<String, String> {
    let view_key_bytes = parse_hex_32(view_key)?;
    let spend_key_bytes = parse_hex_32(spend_key)?;
    let tx_pub_key_bytes = parse_hex_32(tx_pub_key)?;

    // Derive key offset
    let key_offset = derive_key_offset(&view_key_bytes, &tx_pub_key_bytes, output_index as usize)
        .map_err(|e| e.to_string())?;

    // Parse spend key
    let spend_scalar = subtle::CtOption::<curve25519_dalek::Scalar>::from(
        curve25519_dalek::Scalar::from_canonical_bytes(spend_key_bytes)
    );
    if !bool::from(spend_scalar.is_some()) {
        return Err("Invalid spend key".to_string());
    }
    let spend_scalar = spend_scalar.unwrap();

    // one_time_key = spend_key + key_offset
    let one_time_key = spend_scalar + curve25519_dalek::Scalar::from(key_offset.into());

    // Parse output key point
    let output_point = parse_point(output_key)?;

    // Compute Hp(output_key)
    let hp = Point::biased_hash(output_point.compress().to_bytes());

    // Key image = one_time_key * Hp(output_key)
    let key_image = curve25519_dalek::EdwardsPoint::from(hp.into()) * one_time_key;
    let key_image_compressed = key_image.compress();

    Ok(hex::encode(key_image_compressed.to_bytes()))
}
