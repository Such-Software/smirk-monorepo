//! Transaction parsing. Construction and signing live in `signing.rs`.

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
