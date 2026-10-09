//! Proof that a key image belongs to a tip output, for the tip sweep report.
//!
//! The backend settles an XMR/WOW tip only on a sweep the claimer reports, and
//! it cannot tell a sweep from a stranger's ring that merely sampled the tip
//! output: it holds the view key, never the spend key. So the claimer reports
//! the key image it spent each tip output with, and proves the key image is
//! that output's, `I = x·Hp(P)` for the output key `P = x·G`. The daemon then
//! shows which transaction spent `I`.
//!
//! The proof is a discrete-log-equality proof (Chaum-Pedersen, Fiat-Shamir),
//! the definition the backend verifies (`smirk-backend-core`,
//! `src/core/crypto/key_image.rs`); both sides assert one shared vector:
//!
//! ```text
//! k random;  A = k·G;  B = k·Hp(P)
//! c = Hs("smirk-tip-sweep-key-image-v1" || tip_id (16 bytes) || P || I || A || B)
//! s = k - c·x                                   proof = c || s
//! ```
//!
//! `Hs` is Keccak-256 reduced modulo the group order and `Hp` is Monero's
//! `hash_to_ec` (`Point::biased_hash`). The proof reveals nothing about `x`.

use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, EdwardsPoint, Scalar as DScalar};
use monero_oxide::ed25519::Point;
use monero_oxide::primitives::keccak256;
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::output::derive_key_offset;
use crate::result::WasmResult;

/// Domain separator for the proof's challenge (shared with the backend).
const DOMAIN: &[u8] = b"smirk-tip-sweep-key-image-v1";

/// One tip output's key image and its proof, in the backend's wire form.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct TipKeyImageProof {
    pub output_key: String,
    pub key_image: String,
    pub proof: String,
}

/// Prove the key image of one tip output for the sweep report.
///
/// # Arguments
/// * `view_key` / `spend_key` - the tip's private keys (hex)
/// * `tx_pub_key` / `output_index` - the output, as the light-wallet server
///   lists it (tip addresses are primary addresses, no subaddress)
/// * `output_key` - the output's one-time public key (hex)
/// * `tip_id` - the tip's id (a UUID, with or without hyphens), which the
///   proof is bound to
///
/// # Returns
/// JSON `{ "success": true, "data": { "output_key", "key_image", "proof" } }`,
/// or an error when the keys do not control `output_key`.
#[wasm_bindgen]
pub fn prove_tip_key_image(
    view_key: &str,
    spend_key: &str,
    tx_pub_key: &str,
    output_index: u32,
    output_key: &str,
    tip_id: &str,
) -> String {
    let mut nonce_bytes = Zeroizing::new([0u8; 64]);
    OsRng.fill_bytes(nonce_bytes.as_mut());
    let nonce = Zeroizing::new(DScalar::from_bytes_mod_order_wide(&nonce_bytes));
    match prove_inner(
        view_key,
        spend_key,
        tx_pub_key,
        output_index,
        output_key,
        tip_id,
        &nonce,
    ) {
        Ok(proof) => WasmResult::ok(proof),
        Err(e) => WasmResult::err(&e),
    }
}

fn prove_inner(
    view_key: &str,
    spend_key: &str,
    tx_pub_key: &str,
    output_index: u32,
    output_key: &str,
    tip_id: &str,
    nonce: &DScalar,
) -> Result<TipKeyImageProof, String> {
    let tip_id = parse_tip_id(tip_id)?;
    let view_key = Zeroizing::new(parse_hex_32(view_key)?);
    let spend_key = Zeroizing::new(parse_hex_32(spend_key)?);
    let tx_pub_key = parse_hex_32(tx_pub_key)?;
    let output_key = parse_hex_32(output_key)?;

    let spend = Option::<DScalar>::from(DScalar::from_canonical_bytes(*spend_key))
        .ok_or_else(|| "Invalid spend key".to_string())?;
    let offset = derive_key_offset(&view_key, &tx_pub_key, output_index as usize, None)
        .map_err(|e| e.to_string())?;
    let offset: DScalar = offset.into();
    let x = Zeroizing::new(spend + offset);

    // Fail closed, as the key-image derivation does: the recovered one-time key
    // must control this output, or the proof would be for nothing.
    if (ED25519_BASEPOINT_POINT * *x).compress().to_bytes() != output_key {
        return Err(
            "Output one-time key mismatch: these keys do not control the output".to_string(),
        );
    }
    Ok(prove_for_key(&tip_id, &x, nonce))
}

/// The proof for the output whose one-time private key is `x`.
fn prove_for_key(tip_id: &[u8; 16], x: &DScalar, nonce: &DScalar) -> TipKeyImageProof {
    let output_key = (ED25519_BASEPOINT_POINT * x).compress().to_bytes();
    let hp: EdwardsPoint = Point::biased_hash(output_key).into();
    let key_image = (hp * x).compress().to_bytes();
    let a = ED25519_BASEPOINT_POINT * nonce;
    let b = hp * nonce;

    let mut transcript = Vec::with_capacity(DOMAIN.len() + 16 + 32 * 4);
    transcript.extend_from_slice(DOMAIN);
    transcript.extend_from_slice(tip_id);
    transcript.extend_from_slice(&output_key);
    transcript.extend_from_slice(&key_image);
    transcript.extend_from_slice(a.compress().as_bytes());
    transcript.extend_from_slice(b.compress().as_bytes());
    let c = DScalar::from_bytes_mod_order(keccak256(&transcript));
    let s = nonce - c * x;

    let mut proof = [0u8; 64];
    proof[..32].copy_from_slice(c.as_bytes());
    proof[32..].copy_from_slice(s.as_bytes());
    TipKeyImageProof {
        output_key: hex::encode(output_key),
        key_image: hex::encode(key_image),
        proof: hex::encode(proof),
    }
}

fn parse_hex_32(s: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(s.trim()).map_err(|e| format!("Invalid hex: {e}"))?;
    bytes
        .try_into()
        .map_err(|b: Vec<u8>| format!("Expected 32 bytes, got {}", b.len()))
}

/// A UUID's 16 bytes, from its hyphenated or plain hex form.
fn parse_tip_id(s: &str) -> Result<[u8; 16], String> {
    let compact: String = s.trim().chars().filter(|c| *c != '-').collect();
    let bytes = hex::decode(&compact).map_err(|_| "Invalid tip id".to_string())?;
    bytes.try_into().map_err(|_| "Invalid tip id".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vector the backend asserts in `key_image.rs`
    /// (`the_wallet_and_the_backend_agree_on_a_fixed_vector`).
    #[test]
    fn the_wallet_and_the_backend_agree_on_a_fixed_vector() {
        let tip = parse_tip_id("00112233-4455-6677-8899-aabbccddeeff").unwrap();
        let x = DScalar::from_bytes_mod_order([0x11; 32]);
        let nonce = DScalar::from_bytes_mod_order([0x22; 32]);
        assert_eq!(
            prove_for_key(&tip, &x, &nonce),
            TipKeyImageProof {
                output_key: "857eed804ff087b97f87848f6493e87257a8c5203cb9f422f6e7a7d8a4d299f3"
                    .into(),
                key_image: "155de36aa3cf954d3196812427cf46b7bdce067ba4b151642ddda61f1d14f19d"
                    .into(),
                proof: "66669c10e1757b09f3c43fc00cad98599731b05c75bb59912138e632b2d8dc0f\
                        43a6cb2ec3e77b7bd9ce06af5d9a8eb29faffa483de386de9f447702a5636c06"
                    .into(),
            }
        );
    }

    /// The proven key image is the one the wallet's key-image derivation (and
    /// so the network) computes for the output.
    #[test]
    fn the_proven_key_image_is_the_outputs_key_image() {
        let x = DScalar::from_bytes_mod_order([0x33; 32]);
        let p = (ED25519_BASEPOINT_POINT * x).compress().to_bytes();
        let hp: EdwardsPoint = Point::biased_hash(p).into();
        let expected = hex::encode((hp * x).compress().to_bytes());
        let proof = prove_for_key(&[7; 16], &x, &DScalar::from_bytes_mod_order([0x44; 32]));
        assert_eq!(proof.key_image, expected);
    }

    #[test]
    fn keys_that_do_not_control_the_output_are_refused() {
        let err = prove_inner(
            &"01".repeat(32),
            &"02".repeat(32),
            &hex::encode(ED25519_BASEPOINT_POINT.compress().to_bytes()),
            0,
            &hex::encode(
                (ED25519_BASEPOINT_POINT * DScalar::from(5u8))
                    .compress()
                    .to_bytes(),
            ),
            "00112233-4455-6677-8899-aabbccddeeff",
            &DScalar::from(9u8),
        )
        .unwrap_err();
        assert!(err.contains("mismatch"), "{err}");
    }

    #[test]
    fn tip_ids_parse_with_or_without_hyphens_and_nothing_else() {
        assert_eq!(
            parse_tip_id("00112233-4455-6677-8899-aabbccddeeff").unwrap(),
            parse_tip_id("00112233445566778899aabbccddeeff").unwrap()
        );
        assert!(parse_tip_id("not-a-uuid").is_err());
        assert!(parse_tip_id("0011").is_err());
    }
}
