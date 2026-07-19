//! Transaction signing - construct and sign Monero transactions.
//!
//! This module handles the core transaction construction flow:
//! 1. Parse owned outputs from LWS `get_unspent_outs`
//! 2. Parse decoy ring members from LWS `get_random_outs`
//! 3. Combine into `OutputWithDecoys`
//! 4. Build `SignableTransaction` with destination and change
//! 5. Sign with the spend key
//
// TODO(post-port-review): this module was lifted verbatim from the
// pre-monorepo `smirk-wasm-monero` package; it carries some clippy
// noise (useless_conversion on dalek wrappers, manual checked_div /
// div_ceil in fee math). Allowed here so CI passes; clean up when
// we revisit XMR/WOW signing for the registry-aware send flow.
#![allow(
    clippy::useless_conversion,
    clippy::manual_div_ceil,
    clippy::manual_checked_ops,
)]

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use monero_oxide::ed25519::{CompressedPoint, Point, Scalar, Commitment};
use monero_oxide::ringct::{RctType, clsag::Decoys};
use monero_oxide::transaction::Transaction;
use monero_wallet::{
    OutputWithDecoys,
    address::{MoneroAddress, AddressType, Network},
    interface::FeeRate,
    send::{Change, SignableTransaction},
};

use crate::output::{derive_key_offset, derive_commitment_mask};
use crate::result::WasmResult;

/// Deserialize a `u64` from either a JSON number or a decimal string. The backend
/// sends atomic amounts as strings so a value above 2^53 is not mangled by a
/// JavaScript number before it reaches the signer; older callers that still send a
/// JSON number keep working. Signing math is unchanged: the result is the same
/// `u64` either way.
fn de_u64_flex<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, Visitor};
    struct FlexU64;
    impl Visitor<'_> for FlexU64 {
        type Value = u64;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a u64 as a JSON number or a decimal string")
        }
        fn visit_u64<E>(self, v: u64) -> Result<u64, E> {
            Ok(v)
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<u64, E> {
            u64::try_from(v).map_err(|_| E::custom("amount must be a non-negative integer"))
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<u64, E> {
            v.parse::<u64>()
                .map_err(|_| E::custom("amount string is not a valid u64"))
        }
    }
    deserializer.deserialize_any(FlexU64)
}

/// Generate a fresh per-transaction `outgoing_view_key` from OS randomness.
///
/// SECURITY: `outgoing_view_key` is treated as a private key by monero-oxide
/// — it seeds the RNG that produces the per-tx scalar `r` and the ECDH
/// shared secrets with each receiver. A constant value (e.g. zeros) lets
/// any observer recompute `r`, derive the same shared secret, and decrypt
/// amounts or link outputs back to the recipient.
///
/// Reuse across two signs of the same UTXO is also catastrophic: the same
/// seed produces the same CLSAG nonce, and CLSAG nonce reuse on shared key
/// material leaks the spend key. Per-tx randomness from `OsRng` avoids
/// both failure modes.
///
/// **Do not** replace this with a hardcoded value, a hash of the spend
/// key, or any other deterministic source. The regression test
/// `test_outgoing_view_key_is_fresh_per_call` asserts this.
pub(crate) fn fresh_outgoing_view_key() -> Zeroizing<[u8; 32]> {
    use rand_core::RngCore;
    let mut bytes = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut bytes);
    Zeroizing::new(bytes)
}

// ============================================================================
// Input types from LWS
// ============================================================================

/// An unspent output from LWS `get_unspent_outs`.
///
/// `height` and `rct` are deserialized but not currently read — they're
/// part of the LWS API contract (round-trip fidelity) and `rct` becomes
/// load-bearing once we wire the RingCT commitment-recovery path; until
/// then dead-code-allowed.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct LwsOutput {
    /// Amount in atomic units (JSON number or decimal string)
    #[serde(deserialize_with = "de_u64_flex")]
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
    /// Amount in atomic units (JSON number or decimal string)
    #[serde(deserialize_with = "de_u64_flex")]
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
    /// Coin type: "xmr" or "wow" - affects RCT type encoding
    #[serde(default = "default_coin")]
    pub coin: String,
}

fn default_network() -> String {
    "mainnet".to_string()
}

fn default_coin() -> String {
    "xmr".to_string()
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
// Address parsing helpers
// ============================================================================

/// Parse a Monero or Wownero address.
///
/// Monero addresses use single-byte prefixes (18, 19, 42, etc.) which monero-oxide handles.
/// Wownero addresses use multi-byte varint prefixes (4146, 6810, 12208) which we parse manually.
fn parse_address(address: &str, network: Network) -> Result<MoneroAddress, String> {
    // Try Monero first
    if let Ok(addr) = MoneroAddress::from_str(network, address) {
        return Ok(addr);
    }

    // Try Wownero (multi-byte varint prefixes)
    parse_wownero_address(address, network)
}

/// Parse a Wownero address manually.
///
/// Wownero prefixes from upstream `cryptonote_config.h`:
/// - Standard:    4146  (0x1032, varint [0xB2, 0x20])
/// - Integrated:  4148  (0x1034, varint [0xB4, 0x20])
/// - Subaddress: 12208  (0x2FB0, varint [0xB0, 0x5F])
///
/// Pre-2026-05-12: the integrated arm was 6810, which doesn't match any
/// real Wownero address — phantom value from a stale doc. Verified by
/// round-tripping a Stack-Wallet subaddress (`WW3pXrjga...CCM5ge` →
/// prefix 12208) and aligning with current upstream constants.
fn parse_wownero_address(address: &str, network: Network) -> Result<MoneroAddress, String> {
    use monero_base58::decode_check;

    let raw = decode_check(address).ok_or("Invalid base58 encoding")?;
    if raw.len() < 65 {
        return Err("Address too short".to_string());
    }

    // Read varint prefix
    let (prefix, prefix_len) = read_varint(&raw)?;

    // Determine address type from prefix
    let (is_subaddress, has_payment_id) = match prefix {
        4146 => (false, false),   // Standard
        4148 => (false, true),    // Integrated
        12208 => (true, false),   // Subaddress
        _ => return Err(format!("Unknown Wownero prefix: {}", prefix)),
    };

    // Expected lengths
    let expected_len = if has_payment_id {
        prefix_len + 32 + 32 + 8
    } else {
        prefix_len + 32 + 32
    };

    if raw.len() != expected_len {
        return Err(format!("Invalid address length: expected {}, got {}", expected_len, raw.len()));
    }

    // Extract keys
    let spend_bytes: [u8; 32] = raw[prefix_len..prefix_len + 32]
        .try_into()
        .map_err(|_| "Invalid spend key length")?;
    let view_bytes: [u8; 32] = raw[prefix_len + 32..prefix_len + 64]
        .try_into()
        .map_err(|_| "Invalid view key length")?;

    // Decompress to Points
    let spend = CompressedPoint::from(spend_bytes)
        .decompress()
        .ok_or("Invalid spend key - not on curve")?;
    let view = CompressedPoint::from(view_bytes)
        .decompress()
        .ok_or("Invalid view key - not on curve")?;

    // Determine address type
    let kind = if is_subaddress {
        AddressType::Subaddress
    } else if has_payment_id {
        // Extract payment ID for integrated addresses
        let payment_id: [u8; 8] = raw[prefix_len + 64..prefix_len + 72]
            .try_into()
            .map_err(|_| "Invalid payment ID")?;
        AddressType::LegacyIntegrated(payment_id)
    } else {
        AddressType::Legacy
    };

    Ok(MoneroAddress::new(network, kind, spend, view))
}

/// Read a varint from bytes, returning (value, bytes_consumed).
fn read_varint(data: &[u8]) -> Result<(u64, usize), String> {
    let mut result: u64 = 0;
    let mut shift = 0;

    for (i, &byte) in data.iter().enumerate() {
        if i >= 10 {
            return Err("Varint too long".to_string());
        }

        result |= ((byte & 0x7F) as u64) << shift;

        if byte & 0x80 == 0 {
            return Ok((result, i + 1));
        }

        shift += 7;
    }

    Err("Incomplete varint".to_string())
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

    // Normalize coin type
    let coin_lower = params.coin.to_lowercase();

    // Parse keys
    let view_key = parse_hex_32(&params.view_key)?;
    let spend_key_bytes = parse_hex_32(&params.spend_key)?;

    let spend_scalar = Scalar::from(
        subtle::CtOption::<curve25519_dalek::Scalar>::from(
            curve25519_dalek::Scalar::from_canonical_bytes(spend_key_bytes)
        ).unwrap()
    );

    // Check ring size:
    // - XMR: 16 (15 decoys + 1 real)
    // - WOW: 22 (21 decoys + 1 real) - required since HF v9
    let expected_decoys = if coin_lower == "wow" { 21 } else { 15 };
    for (i, input) in params.inputs.iter().enumerate() {
        if input.decoys.len() != expected_decoys {
            return Err(format!(
                "Input {} has {} decoys, expected {} for coin '{}' (ring size {})",
                i,
                input.decoys.len(),
                expected_decoys,
                params.coin,
                expected_decoys + 1
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

    // Parse destination addresses (supports both Monero and Wownero)
    let mut payments: Vec<(MoneroAddress, u64)> = Vec::new();
    for dest in &params.destinations {
        let addr = parse_address(&dest.address, network)
            .map_err(|e| format!("Invalid address '{}': {}", dest.address, e))?;
        payments.push((addr, dest.amount));
    }

    // Parse change address (supports both Monero and Wownero)
    let change_addr = parse_address(&params.change_address, network)
        .map_err(|e| format!("Invalid change address '{}': {}", params.change_address, e))?;

    // Create fee rate
    let fee_rate = FeeRate::new(params.fee_per_byte, params.fee_mask)
        .ok_or("Invalid fee rate")?;

    let outgoing_view_key = fresh_outgoing_view_key();

    // Build SignableTransaction
    // Note: Change::fingerprintable is used as we don't have the full view pair
    let change = Change::fingerprintable(Some(change_addr));

    // Use Wownero-specific RCT type for WOW (ring size 22 = 21 decoys)
    let rct_type = if params.coin.to_lowercase() == "wow" {
        RctType::WowneroClsagBulletproofPlus
    } else {
        RctType::ClsagBulletproofPlus
    };

    let signable = SignableTransaction::new(
        rct_type,
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
    // For Wownero (WowneroClsagBulletproofPlus), monero-oxide now handles:
    // - Serializing RCT type as 8 (not 6)
    // - Scaling outPk commitments by INV_EIGHT
    // So no post-processing is needed here.
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

/// Compute key image without needing the output public key.
///
/// This version derives the output key from the view/spend keys and tx_pub_key,
/// useful for verifying spent outputs from LWS which doesn't provide output_key.
///
/// Returns JSON: { "success": true, "data": "<key_image_hex>" }
/// or: { "success": false, "error": "<message>" }
#[wasm_bindgen]
pub fn compute_key_image(
    view_key: &str,
    spend_key: &str,
    tx_pub_key: &str,
    output_index: u32,
) -> String {
    match compute_key_image_inner(view_key, spend_key, tx_pub_key, output_index) {
        Ok(ki) => WasmResult::ok(ki),
        Err(e) => WasmResult::err(&e),
    }
}

fn compute_key_image_inner(
    view_key: &str,
    spend_key: &str,
    tx_pub_key: &str,
    output_index: u32,
) -> Result<String, String> {
    let view_key_bytes = parse_hex_32(view_key)?;
    let spend_key_bytes = parse_hex_32(spend_key)?;
    let tx_pub_key_bytes = parse_hex_32(tx_pub_key)?;

    // Derive key offset: Hs(a*R || output_index)
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

    // one_time_private_key = spend_key + key_offset
    let one_time_private_key = spend_scalar + curve25519_dalek::Scalar::from(key_offset.into());

    // Derive the output public key: P = one_time_private_key * G
    let output_point = curve25519_dalek::constants::ED25519_BASEPOINT_POINT * one_time_private_key;
    let output_point_bytes = output_point.compress().to_bytes();

    // Compute Hp(P) using monero-oxide's biased_hash (proper hash_to_point)
    let hp = Point::biased_hash(output_point_bytes);

    // Key image = one_time_private_key * Hp(P)
    let key_image = curve25519_dalek::EdwardsPoint::from(hp.into()) * one_time_private_key;
    let key_image_compressed = key_image.compress();

    Ok(hex::encode(key_image_compressed.to_bytes()))
}

#[cfg(test)]
mod amount_deser_tests {
    use super::{LwsOutput, TxDestination};

    // Above 2^53: JSON-number precision would be lost in JavaScript, so the wallet
    // sends the amount as a decimal string. The signer must parse it exactly.
    const BIG: u64 = 9_007_199_254_740_993; // 2^53 + 1

    #[test]
    fn lws_output_amount_from_string_is_exact() {
        let json = format!(
            r#"{{"amount":"{BIG}","public_key":"aa","tx_pub_key":"bb","index":0,"global_index":1,"height":2,"rct":""}}"#
        );
        let out: LwsOutput = serde_json::from_str(&json).unwrap();
        assert_eq!(out.amount, BIG);
    }

    #[test]
    fn lws_output_amount_from_number_still_works() {
        // Backward compatibility: a JSON number (small, exact) must still deserialize.
        let json = r#"{"amount":12345,"public_key":"aa","tx_pub_key":"bb","index":0,"global_index":1,"height":2,"rct":""}"#;
        let out: LwsOutput = serde_json::from_str(json).unwrap();
        assert_eq!(out.amount, 12345);
    }

    #[test]
    fn destination_amount_from_string_is_exact() {
        let json = format!(r#"{{"address":"x","amount":"{BIG}"}}"#);
        let dest: TxDestination = serde_json::from_str(&json).unwrap();
        assert_eq!(dest.amount, BIG);
    }

    #[test]
    fn negative_or_garbage_amount_is_rejected() {
        assert!(serde_json::from_str::<TxDestination>(r#"{"address":"x","amount":"-1"}"#).is_err());
        assert!(serde_json::from_str::<TxDestination>(r#"{"address":"x","amount":"nope"}"#).is_err());
    }
}
