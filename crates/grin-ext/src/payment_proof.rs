//! Grin payment proofs: cryptographically-signed receipts.
//!
//! Reference: `grin-wallet/libwallet/src/internal/tx.rs::payment_proof_message`.
//!
//! When a slate carries a `proof` field, the receiver attests that they
//! received a specific amount sent to a specific kernel commitment, signed
//! with their slatepack-address ed25519 key. The sender (or anyone) can
//! later verify this attestation cryptographically.
//!
//! Signed message format (73 bytes):
//!
//! ```text
//!   amount            : u64 BE                    (8 bytes)
//!   kernel_commitment : 33 bytes (Grin's 0x08/0x09-prefix encoding)
//!   sender_address    : 32 bytes ed25519 pubkey   (bech32 slatepack addr decoded)
//! ```
//!
//! The receiver signs this with their slatepack-address ed25519 secret
//! key. The signature is the 64-byte `rsig` that goes in `slate.proof`.
//!
//! Use cases:
//! - Dispute resolution: cryptographic proof of receipt
//! - Audit trail: regulators / accountants want a non-repudiable record
//! - Escrow: lawyer or arbiter can verify payment was received
//! - Subscription / merchant flows: prove a payment matches a specific invoice

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

/// Length of the message that gets ed25519-signed for a payment proof.
pub const PROOF_MSG_LEN: usize = 8 + 33 + 32;

/// Length of an ed25519 signature.
pub const PROOF_SIG_LEN: usize = 64;

/// Build the 73-byte message that gets ed25519-signed for a payment proof.
///
/// Layout matches `grin-wallet`:
/// ```text
///   u64 BE amount || 33-byte kernel_commitment || 32-byte sender_address
/// ```
pub fn payment_proof_message(
    amount: u64,
    kernel_commitment: &[u8; 33],
    sender_address_ed25519_pub: &[u8; 32],
) -> [u8; PROOF_MSG_LEN] {
    let mut msg = [0u8; PROOF_MSG_LEN];
    msg[..8].copy_from_slice(&amount.to_be_bytes());
    msg[8..41].copy_from_slice(kernel_commitment);
    msg[41..73].copy_from_slice(sender_address_ed25519_pub);
    msg
}

/// Sign a payment proof with the receiver's slatepack-address ed25519
/// secret key.
///
/// The secret bytes are the 32-byte ed25519 seed (the value
/// `crate::slatepack_address::slatepack_address_ed25519_secret` produces
/// for the same mnemonic + index that generated the receiver's slatepack
/// address).
pub fn sign_payment_proof(
    amount: u64,
    kernel_commitment: &[u8; 33],
    sender_address_ed25519_pub: &[u8; 32],
    receiver_ed25519_secret: &[u8; 32],
) -> [u8; PROOF_SIG_LEN] {
    let msg = payment_proof_message(amount, kernel_commitment, sender_address_ed25519_pub);
    let signing_key = SigningKey::from_bytes(receiver_ed25519_secret);
    signing_key.sign(&msg).to_bytes()
}

/// Verify a payment proof signature.
///
/// Returns `Ok(true)` if the receiver's signature is valid for the given
/// payment, `Ok(false)` if the signature is well-formed but doesn't match,
/// `Err(_)` if the receiver address bytes can't be decoded as a valid
/// ed25519 public key.
pub fn verify_payment_proof(
    amount: u64,
    kernel_commitment: &[u8; 33],
    sender_address_ed25519_pub: &[u8; 32],
    receiver_address_ed25519_pub: &[u8; 32],
    signature: &[u8; PROOF_SIG_LEN],
) -> Result<bool, String> {
    let msg = payment_proof_message(amount, kernel_commitment, sender_address_ed25519_pub);
    let pk = VerifyingKey::from_bytes(receiver_address_ed25519_pub)
        .map_err(|e| format!("invalid receiver address ed25519 pubkey: {e}"))?;
    let sig = Signature::from_bytes(signature);
    Ok(pk.verify(&msg, &sig).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn kp_from_seed(seed: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
        let sk = SigningKey::from_bytes(seed);
        (*seed, sk.verifying_key().to_bytes())
    }

    #[test]
    fn message_layout_is_amount_then_commit_then_sender() {
        let amount = 1_234_567u64;
        let commit = [0xab; 33];
        let sender = [0xcd; 32];
        let msg = payment_proof_message(amount, &commit, &sender);
        assert_eq!(msg.len(), 73);
        assert_eq!(&msg[..8], &amount.to_be_bytes());
        assert_eq!(&msg[8..41], &commit);
        assert_eq!(&msg[41..73], &sender);
    }

    #[test]
    fn sign_and_verify_round_trip() {
        let (rx_secret, rx_pub) = kp_from_seed(&[7u8; 32]);
        let sender_pub = [0x42; 32]; // not necessarily a real ed25519: sender's slatepack addr bytes
        let amount = 60_000_000_000u64;
        let commit = [0x91; 33]; // some Grin commitment

        let sig = sign_payment_proof(amount, &commit, &sender_pub, &rx_secret);
        let ok =
            verify_payment_proof(amount, &commit, &sender_pub, &rx_pub, &sig).unwrap();
        assert!(ok, "signature must verify");
    }

    #[test]
    fn verify_rejects_wrong_amount() {
        let (rx_secret, rx_pub) = kp_from_seed(&[1u8; 32]);
        let sender_pub = [0x42; 32];
        let commit = [0x91; 33];
        let sig = sign_payment_proof(100, &commit, &sender_pub, &rx_secret);
        let ok = verify_payment_proof(101, &commit, &sender_pub, &rx_pub, &sig).unwrap();
        assert!(!ok, "verify must reject wrong amount");
    }

    #[test]
    fn verify_rejects_wrong_kernel_commitment() {
        let (rx_secret, rx_pub) = kp_from_seed(&[1u8; 32]);
        let sender_pub = [0x42; 32];
        let mut commit = [0x91; 33];
        let sig = sign_payment_proof(100, &commit, &sender_pub, &rx_secret);
        commit[0] ^= 1;
        let ok = verify_payment_proof(100, &commit, &sender_pub, &rx_pub, &sig).unwrap();
        assert!(!ok);
    }

    #[test]
    fn verify_rejects_wrong_sender_address() {
        let (rx_secret, rx_pub) = kp_from_seed(&[1u8; 32]);
        let mut sender = [0x42; 32];
        let commit = [0x91; 33];
        let sig = sign_payment_proof(100, &commit, &sender, &rx_secret);
        sender[0] ^= 1;
        let ok = verify_payment_proof(100, &commit, &sender, &rx_pub, &sig).unwrap();
        assert!(!ok);
    }

    #[test]
    fn verify_rejects_wrong_receiver_pubkey() {
        let (rx_secret, _rx_pub) = kp_from_seed(&[1u8; 32]);
        let (_other_sk, other_pub) = kp_from_seed(&[2u8; 32]);
        let sender = [0x42; 32];
        let commit = [0x91; 33];
        let sig = sign_payment_proof(100, &commit, &sender, &rx_secret);
        let ok = verify_payment_proof(100, &commit, &sender, &other_pub, &sig).unwrap();
        assert!(!ok, "verify must reject signature against the wrong receiver pubkey");
    }

    #[test]
    fn verify_rejects_tampered_signature() {
        let (rx_secret, rx_pub) = kp_from_seed(&[1u8; 32]);
        let sender = [0x42; 32];
        let commit = [0x91; 33];
        let mut sig = sign_payment_proof(100, &commit, &sender, &rx_secret);
        sig[0] ^= 1;
        let ok = verify_payment_proof(100, &commit, &sender, &rx_pub, &sig).unwrap();
        assert!(!ok);
    }
}
