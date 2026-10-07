//! Unit tests for smirk-wasm.
//!
//! Run with: cargo test

// Nested `tests::tests` module: renaming it would change every test
// path, so `clippy::module_inception` is allowed here.
#[cfg(test)]
#[allow(clippy::module_inception)]
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
        let params = serde_json::json!({
            "inputs": [],
            "destinations": [{"address": "test", "amount": 1000}],
            "change_address": "test",
            "fee_per_byte": 20,
            "fee_mask": 10000,
            "view_key": "0".repeat(64),
            "spend_key": "0".repeat(64),
            "network": "mainnet"
        });
        let result = crate::signing::sign_transaction(&params.to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("No inputs"));
    }

    #[test]
    fn test_sign_transaction_wrong_ring_size() {
        let params = serde_json::json!({
            "inputs": [{
                "output": {
                    "amount": 1000000,
                    "public_key": "0".repeat(64),
                    "tx_pub_key": "0".repeat(64),
                    "index": 0,
                    "global_index": 12345,
                    "height": 1000,
                    "rct": "0".repeat(64)
                },
                "decoys": []  // Should be 15 decoys
            }],
            "destinations": [{"address": "test", "amount": 500000}],
            "change_address": "test",
            "fee_per_byte": 20,
            "fee_mask": 10000,
            "view_key": "0".repeat(64),
            "spend_key": "0".repeat(64),
            "network": "mainnet"
        });
        let result = crate::signing::sign_transaction(&params.to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("decoys"));
    }

    /// SECURITY REGRESSION: `outgoing_view_key` is treated as a private key
    /// by monero-oxide; reusing it (or, worst case, hardcoding it to zeros)
    /// lets observers recompute per-tx scalars, derive the same ECDH shared
    /// secrets as the receiver, and decrypt amounts / link outputs.
    ///
    /// This test asserts every call returns a fresh, non-zero, distinct
    /// 32-byte key. If anyone ever reverts to a constant or deterministic
    /// value, this fails immediately.
    ///
    /// Not hypothetical: an earlier implementation hardcoded
    /// `Zeroizing::new([0u8; 32])` here, breaking amount privacy on all
    /// outgoing XMR/WOW transactions.
    /// A swap memo rides in `tx_extra` arbitrary data. An absent memo must add
    /// nothing (ordinary sends stay byte-identical), and a memo that does not
    /// fit must be refused, never truncated: a truncated swap memo routes the
    /// deposit by whatever prefix survived.
    #[test]
    fn test_memo_data_bounds() {
        use monero_wallet::extra::MAX_ARBITRARY_DATA_SIZE;
        assert!(crate::signing::memo_data(None).unwrap().is_empty());
        let memo = "=:b:bc1qjc86s9s508ttkryzsk35agghhv664a6an5eclv/4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge:1000";
        assert_eq!(
            crate::signing::memo_data(Some(memo)).unwrap(),
            vec![memo.as_bytes().to_vec()]
        );
        let at_limit = "a".repeat(MAX_ARBITRARY_DATA_SIZE);
        assert!(crate::signing::memo_data(Some(&at_limit)).is_ok());
        let over = "a".repeat(MAX_ARBITRARY_DATA_SIZE + 1);
        assert!(crate::signing::memo_data(Some(&over)).is_err());
        assert!(crate::signing::memo_data(Some("")).is_err());
    }

    #[test]
    fn test_outgoing_view_key_is_fresh_per_call() {
        use std::collections::HashSet;

        const N: usize = 256;
        let mut seen: HashSet<[u8; 32]> = HashSet::with_capacity(N);
        for _ in 0..N {
            let ovk = crate::signing::fresh_outgoing_view_key();
            let bytes: [u8; 32] = *ovk;
            assert_ne!(
                bytes, [0u8; 32],
                "outgoing_view_key must NEVER be all zeros — \
                 this seeds the per-tx RNG and is treated as a private key"
            );
            assert!(
                seen.insert(bytes),
                "outgoing_view_key collision in {} samples — \
                 the source MUST be fresh randomness, not deterministic",
                N
            );
        }
    }

    /// An `extra` holding exactly one primary tx public key (tag 0x01).
    fn extra_with_key(point: curve25519_dalek::EdwardsPoint) -> Vec<u8> {
        let mut out = vec![0x01u8];
        out.extend_from_slice(point.compress().as_bytes());
        out
    }

    fn sample_tx_key() -> zeroize::Zeroizing<monero_oxide::ed25519::Scalar> {
        let ovk = zeroize::Zeroizing::new([7u8; 32]);
        let g = monero_oxide::ed25519::Point::from(curve25519_dalek::constants::ED25519_BASEPOINT_POINT);
        crate::signing::derive_tx_key(&ovk, vec![(g, g)])
    }

    /// The tx key is reported only when it matches the key the transaction
    /// published, so a payment proof built from it can be trusted.
    #[test]
    fn test_tx_key_returned_when_it_matches_the_published_key() {
        let key = sample_tx_key();
        let scalar: curve25519_dalek::Scalar = (*key).into();
        let extra = extra_with_key(curve25519_dalek::constants::ED25519_BASEPOINT_POINT * scalar);
        let hex = crate::signing::verified_tx_key_hex(&key, &extra).expect("matching key");
        let bytes = <[u8; 32]>::from(*key);
        assert_eq!(hex, hex::encode(bytes));
    }

    /// A subaddress send publishes `r·D`, not `r·G`; any mismatch must yield no
    /// key rather than one that produces a false proof.
    #[test]
    fn test_tx_key_withheld_on_mismatch_or_missing_key() {
        let key = sample_tx_key();
        let other = curve25519_dalek::constants::ED25519_BASEPOINT_POINT
            * curve25519_dalek::Scalar::from(42u64);
        assert!(crate::signing::verified_tx_key_hex(&key, &extra_with_key(other)).is_none());
        assert!(crate::signing::verified_tx_key_hex(&key, &[]).is_none());
        assert!(crate::signing::verified_tx_key_hex(&key, &[0xff, 0x00, 0x13]).is_none());
    }

    /// Same seed, same inputs: same key. The derivation must be the library's,
    /// not a fresh random draw.
    #[test]
    fn test_derive_tx_key_is_deterministic_for_its_inputs() {
        let a = <[u8; 32]>::from(*sample_tx_key());
        let b = <[u8; 32]>::from(*sample_tx_key());
        assert_eq!(a, b);
    }
}
