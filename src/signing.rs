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
    /// Key offset for deriving the one-time key (hex)
    pub key_offset: String,
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
    /// Private view key (for output encryption) - hex
    pub view_key: String,
    /// Private spend key - hex
    pub spend_key: String,
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
// Transaction building (placeholder)
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
    // Parse parameters
    let params: TxParams = match serde_json::from_str(params_json) {
        Ok(p) => p,
        Err(e) => return WasmResult::err(&format!("Failed to parse params: {}", e)),
    };

    // Validate inputs
    if params.inputs.is_empty() {
        return WasmResult::err("No inputs provided");
    }
    if params.destinations.is_empty() {
        return WasmResult::err("No destinations provided");
    }

    // Check ring size (should be 16 for current Monero)
    for (i, input) in params.inputs.iter().enumerate() {
        if input.decoys.len() != 15 {
            // 15 decoys + 1 real = ring size 16
            return WasmResult::err(&format!(
                "Input {} has {} decoys, expected 15 (ring size 16)",
                i,
                input.decoys.len()
            ));
        }
    }

    // TODO: Implement actual transaction construction
    // This requires:
    // 1. Convert LwsOutput -> WalletOutput (need key derivation)
    // 2. Convert decoys to Decoys struct
    // 3. Create OutputWithDecoys
    // 4. Build SignableTransaction
    // 5. Sign with spend key
    // 6. Serialize to hex

    WasmResult::err("Transaction signing not yet implemented")
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
