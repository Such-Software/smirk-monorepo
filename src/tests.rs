//! Unit tests for smirk-wasm.
//!
//! Run with: cargo test

#[cfg(test)]
mod tests {
    use crate::result::WasmResult;

    // Known test vectors from Monero
    // These are public values, safe to include in tests

    /// Test address from Monero testnet
    const TEST_ADDRESS: &str = "9ujeXrjzf7bfeK3KZdCqnYaMwZVFuXemPU8Ubw335rj2FN1CdMiWNyFV3ksEfMFvRp9L9qum5UxkP5rN9aLcPxbH1au4WAB";

    #[test]
    fn test_wasm_result_ok() {
        let result = WasmResult::ok("test data".to_string());
        assert!(result.contains("\"success\":true"));
        assert!(result.contains("\"data\":\"test data\""));
    }

    #[test]
    fn test_wasm_result_err() {
        let result = WasmResult::err("test error");
        assert!(result.contains("\"success\":false"));
        assert!(result.contains("\"error\":\"test error\""));
    }

    #[test]
    fn test_validate_address_valid() {
        // This is a testnet address
        let result = crate::address::validate_address(TEST_ADDRESS);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(parsed["success"], true);
        assert_eq!(parsed["data"]["valid"], true);
        assert_eq!(parsed["data"]["network"], "testnet");
        assert_eq!(parsed["data"]["is_subaddress"], false);
    }

    #[test]
    fn test_validate_address_invalid() {
        let result = crate::address::validate_address("invalid_address");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("Invalid"));
    }

    #[test]
    fn test_estimate_fee() {
        let result = crate::signing::estimate_fee(2, 2, 20, 10000);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(parsed["success"], true);
        // Fee should be > 0 and rounded to fee_mask
        let fee = parsed["data"].as_u64().unwrap();
        assert!(fee > 0);
        assert_eq!(fee % 10000, 0); // Should be rounded to fee_mask
    }

    #[test]
    fn test_sign_transaction_validation() {
        // Empty params should fail validation
        let result = crate::signing::sign_transaction("{}");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(parsed["success"], false);
        // Should fail with parse error (missing fields)
        assert!(parsed["error"].as_str().unwrap().contains("parse"));
    }

    #[test]
    fn test_sign_transaction_no_inputs() {
        let params = r#"{"inputs":[],"destinations":[{"address":"test","amount":1000}],"change_address":"test","fee_per_byte":20,"fee_mask":10000,"view_key":"00","spend_key":"00"}"#;
        let result = crate::signing::sign_transaction(params);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("No inputs"));
    }
}
