//! Address validation and parsing.

use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::result::WasmResult;

/// Address validation result.
#[derive(Serialize)]
pub struct AddressInfo {
    pub valid: bool,
    pub network: String,
    pub is_subaddress: bool,
    pub has_payment_id: bool,
    pub spend_key: String,
    pub view_key: String,
}

/// Validate a Monero address and return its components.
///
/// Returns JSON with address info or error.
#[wasm_bindgen]
pub fn validate_address(address: &str) -> String {
    use monero_wallet::address::{MoneroAddress, Network};

    match MoneroAddress::from_str_with_unchecked_network(address) {
        Ok(addr) => {
            let network = match addr.network() {
                Network::Mainnet => "mainnet",
                Network::Testnet => "testnet",
                Network::Stagenet => "stagenet",
            };

            WasmResult::ok(AddressInfo {
                valid: true,
                network: network.to_string(),
                is_subaddress: addr.is_subaddress(),
                has_payment_id: addr.payment_id().is_some(),
                spend_key: hex::encode(addr.spend().compress().to_bytes()),
                view_key: hex::encode(addr.view().compress().to_bytes()),
            })
        }
        Err(e) => WasmResult::err(&format!("Invalid address: {:?}", e)),
    }
}
