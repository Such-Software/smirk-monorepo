//! Address validation and parsing.
//!
//! Supports both Monero and Wownero addresses with their different prefix schemes.

use serde::Serialize;
use wasm_bindgen::prelude::*;

use monero_wallet::address::{MoneroAddress, Network};
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

// Wownero uses multi-byte (varint) prefixes, which monero-oxide's AddressBytes doesn't support.
// We need to handle Wownero addresses manually.
//
// Wownero mainnet prefixes (from cryptonote_config.h):
// - Standard: 4146 (0x1032 LE, varint: [0xB2, 0x20])
// - Integrated: 6810 (0x1A9A LE, varint: [0x9A, 0x35])
// - Subaddress: 12208 (0x2FB0 LE, varint: [0xB0, 0x5F])
//
// Base58 first character mapping (approximate):
// - Standard (4146): starts with "Wo"
// - Subaddress (12208): starts with "Ww" or similar
// - Integrated (4148): starts with "Wi"

/// Validate a Wownero address by decoding base58 and checking the varint prefix.
fn validate_wownero_address(address: &str) -> Result<AddressInfo, String> {
    use monero_base58::decode_check;

    let raw = decode_check(address).ok_or("Invalid base58 encoding")?;
    if raw.len() < 65 {
        return Err("Address too short".to_string());
    }

    // Read varint prefix
    let (prefix, prefix_len) = read_varint(&raw)?;

    // Determine address type from prefix.
    //
    // TODO: Wownero testnet validation. Wownero shares the standard prefix
    // (4146) between mainnet and testnet, so prefix alone can't
    // disambiguate; would need a leading-character or version-byte
    // check. Until we have testnet support in the wallet, mainnet-only
    // is acceptable.
    let (network, is_subaddress, has_payment_id) = match prefix {
        4146 => ("mainnet", false, false),   // Standard
        4148 => ("mainnet", false, true),    // Integrated (upstream cryptonote_config.h; was 6810)
        12208 => ("mainnet", true, false),   // Subaddress
        _ => return Err(format!("Unknown Wownero prefix: {}", prefix)),
    };

    // Expected lengths:
    // Standard: prefix (1-2 bytes) + spend_key (32) + view_key (32) = 65-66 bytes
    // Integrated: prefix + spend_key + view_key + payment_id (8) = 73-74 bytes
    // Subaddress: same as standard

    let expected_len = if has_payment_id {
        prefix_len + 32 + 32 + 8
    } else {
        prefix_len + 32 + 32
    };

    if raw.len() != expected_len {
        return Err(format!("Invalid address length: expected {}, got {}", expected_len, raw.len()));
    }

    // Extract keys
    let spend_key = &raw[prefix_len..prefix_len + 32];
    let view_key = &raw[prefix_len + 32..prefix_len + 64];

    // Validate keys are valid curve points
    use monero_ed25519::CompressedPoint;
    let spend_bytes: [u8; 32] = spend_key.try_into().map_err(|_| "Invalid spend key length")?;
    let view_bytes: [u8; 32] = view_key.try_into().map_err(|_| "Invalid view key length")?;

    let spend_compressed = CompressedPoint::from(spend_bytes);
    let view_compressed = CompressedPoint::from(view_bytes);

    // Try to decompress to validate they're on the curve
    spend_compressed.decompress().ok_or("Invalid spend key - not on curve")?;
    view_compressed.decompress().ok_or("Invalid view key - not on curve")?;

    Ok(AddressInfo {
        valid: true,
        network: network.to_string(),
        is_subaddress,
        has_payment_id,
        spend_key: hex::encode(spend_key),
        view_key: hex::encode(view_key),
    })
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

/// Validate a Monero or Wownero address and return its components.
///
/// Automatically detects the address type based on prefix.
///
/// Returns JSON with address info or error.
#[wasm_bindgen]
pub fn validate_address(address: &str) -> String {
    // Try Monero first (single-byte prefixes: 4, 18, 19, 42, etc.)
    if let Ok(addr) = MoneroAddress::from_str_with_unchecked_network(address) {
        let network = match addr.network() {
            Network::Mainnet => "mainnet",
            Network::Testnet => "testnet",
            Network::Stagenet => "stagenet",
        };

        return WasmResult::ok(AddressInfo {
            valid: true,
            network: network.to_string(),
            is_subaddress: addr.is_subaddress(),
            has_payment_id: addr.payment_id().is_some(),
            spend_key: hex::encode(addr.spend().compress().to_bytes()),
            view_key: hex::encode(addr.view().compress().to_bytes()),
        });
    }

    // Try Wownero (multi-byte varint prefixes)
    match validate_wownero_address(address) {
        Ok(info) => WasmResult::ok(info),
        Err(e) => WasmResult::err(&format!("Invalid address: {}", e)),
    }
}

#[cfg(test)]
mod wownero_prefix_tests {
    use super::*;
    use monero_base58::encode_check;

    // Standard ed25519 basepoint (compressed): a valid curve point, reused for
    // both spend and view keys in synthetic test addresses.
    const POINT: [u8; 32] = [
        0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
        0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
        0x66, 0x66,
    ];

    /// Base58check Wownero address: varint `prefix` + spend + view (+ 8-byte
    /// payment id when integrated).
    fn wow_addr(prefix: &[u8], has_payment_id: bool) -> String {
        let mut raw = Vec::from(prefix);
        raw.extend_from_slice(&POINT);
        raw.extend_from_slice(&POINT);
        if has_payment_id {
            raw.extend_from_slice(&[0u8; 8]);
        }
        encode_check(raw)
    }

    // Regression: the validator carried the phantom integrated prefix 6810
    // instead of upstream 4148, so valid integrated addresses were rejected.
    // Lock the correct mapping; 6810 must now be unknown.
    #[test]
    fn wownero_integrated_prefix_is_4148_not_6810() {
        let integrated = validate_wownero_address(&wow_addr(&[0xB4, 0x20], true))
            .expect("4148 integrated must validate");
        assert!(integrated.has_payment_id);
        assert!(!integrated.is_subaddress);

        assert!(validate_wownero_address(&wow_addr(&[0xB2, 0x20], false)).is_ok()); // 4146 standard
        let sub = validate_wownero_address(&wow_addr(&[0xB0, 0x5F], false))
            .expect("12208 subaddress must validate");
        assert!(sub.is_subaddress);

        // Obsolete 6810 (varint [0x9A, 0x35]) must be rejected.
        assert!(validate_wownero_address(&wow_addr(&[0x9A, 0x35], true)).is_err());
    }
}
