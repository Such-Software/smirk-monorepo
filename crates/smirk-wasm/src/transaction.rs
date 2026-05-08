//! Transaction parsing and construction.

use serde::Serialize;
use wasm_bindgen::prelude::*;

use monero_oxide::transaction::{NotPruned, Transaction};

use crate::result::WasmResult;

/// Parsed transaction info.
#[derive(Serialize)]
pub struct TxInfo {
    pub inputs: usize,
    pub outputs: usize,
    pub version: u8,
}

/// Parse a transaction from hex and return info about it.
///
/// # Arguments
/// * `hex_data` - The transaction as hex-encoded bytes
///
/// # Returns
/// JSON with transaction info (inputs, outputs, version) or error.
#[wasm_bindgen]
pub fn parse_tx(hex_data: &str) -> String {
    let bytes = match hex::decode(hex_data) {
        Ok(b) => b,
        Err(e) => return WasmResult::err(&format!("Hex decode error: {}", e)),
    };

    let mut reader = &bytes[..];
    match Transaction::<NotPruned>::read(&mut reader) {
        Ok(tx) => {
            let version = match &tx {
                Transaction::V1 { .. } => 1,
                Transaction::V2 { .. } => 2,
            };
            WasmResult::ok(TxInfo {
                inputs: tx.prefix().inputs.len(),
                outputs: tx.prefix().outputs.len(),
                version,
            })
        }
        Err(e) => WasmResult::err(&format!("Parse error: {:?}", e)),
    }
}

// ============================================================================
// Transaction Construction (TODO)
// ============================================================================
//
// The following functions will be implemented:
//
// 1. prepare_outputs_with_decoys(outputs_json, decoys_json) -> String
//    Takes owned outputs (from LWS get_unspent_outs) and decoy data
//    (from LWS get_random_outs), returns serialized OutputWithDecoys
//
// 2. create_transaction(
//      outputs_with_decoys_json,
//      destination_address,
//      amount,
//      change_address,
//      fee_per_byte,
//      fee_mask,
//      outgoing_view_key_hex
//    ) -> String
//    Creates a SignableTransaction, returns serialized form
//
// 3. sign_transaction(signable_tx_hex, spend_key_hex) -> String
//    Signs the transaction, returns signed transaction hex for broadcast
