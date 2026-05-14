//! Grin / Mimblewimble protocol implementation for Smirk.
//!
//! This crate is built from primitives — not a fork of grin-wallet. We use
//! audited libraries for crypto (HMAC-SHA512, secp256k1, ed25519, etc.)
//! and reimplement the protocol layer (slate construction, slatepack codec,
//! NRD kernels) so we can extend it with adaptor signatures and other
//! Smirk-specific features in the v0.4+ atomic-swap work.
//!
//! Behavioral correctness is verified against the existing smirk-extension
//! v0.2.x stack (currently using vendored MWC-Wallet code) via golden test
//! vectors. See `tests/` for the test suite and `docs/GRIN_TEST_VECTORS.md`
//! (in smirk-backend) for the methodology.

pub mod bip32;
pub mod blind;
pub mod bulletproof;
pub mod kernel;
pub mod keychain;
pub mod payment_proof;
pub mod schnorr;
pub mod secp256k1;
pub mod seed;
pub mod slate;
pub mod slate_bin;
pub mod slate_builder;
pub mod slatepack;
pub mod slatepack_address;
pub mod slatepack_encryption;
pub mod transaction;
pub mod wallet_flows;

pub use kernel::{KernelFeatures, NRD_MAX_RELATIVE_HEIGHT};
pub use keychain::{derive_blind, SwitchCommitmentType};
pub use slate_builder::{
    receiver_finalize_i3, receiver_init_i1, receiver_init_i1_with_id, receiver_round_s2,
    sender_finalize_s3, sender_init_s1, sender_init_s1_with_id, sender_round_i2,
    ReceiverContext, ReceiverFinalizeI3Output, ReceiverFinalizeI3Params, ReceiverInitI1Output,
    ReceiverInitI1Params, ReceiverRoundOutput, ReceiverRoundParams, SenderContext,
    SenderFinalizeOutput, SenderFinalizeParams, SenderInitOutput, SenderInitParams,
    SenderRoundI2Output, SenderRoundI2Params,
};
pub use transaction::{
    pubkey_to_commitment, slate_to_transaction_bytes, BuildTransactionParams, TxInput, TxOutput,
};
pub use wallet_flows::{
    create_invoice, create_send_transaction, finalize_invoice, finalize_send_slate, sign_invoice,
    sign_incoming_send_slate, ChangeOutputInfo, CreateInvoiceOutput, CreateInvoiceParams,
    CreateSendTxOutput, CreateSendTxParams, FinalizeInvoiceOutput, FinalizeInvoiceParams,
    FinalizeSendOutput, FinalizeSendParams, ReceiverOutputInfo, SignIncomingSendOutput,
    SignIncomingSendParams, SignInvoiceOutput, SignInvoiceParams, UnspentOutput,
};

pub use bulletproof::{
    bullet_proof_create, bullet_proof_rewind, bullet_proof_verify, pedersen_commit,
};

pub use schnorr::{
    adaptor_partial_sign, adaptor_partial_verify, aggregate_partials, complete_adaptor,
    extract_adaptor_secret, final_signature, partial_sign, partial_verify, point_add, point_sum,
    sign as schnorr_sign, sign_with_nonce, verify as schnorr_verify, Signature,
};
pub use secp256k1::{public_key_from_secret_key, random_secret_nonce};
pub use seed::{mnemonic_to_extended_private_key, ExtendedPrivateKey};
pub use slate::{
    add_input_commitment, add_output_commitment, parse_slate_v4, serialize_slate_v4,
    SlateStateV4, SlateV4,
};
pub use slate_bin::{deserialize_slate_v4_bin, serialize_slate_v4_bin};
pub use slatepack::{
    armor as slatepack_armor, dearmor as slatepack_dearmor, SlatepackBin, SlatepackMode,
    SlatepackVersion,
};
pub use slatepack_encryption::{
    decrypt_with_secret, ed25519_pub_to_age_recipient, ed25519_secret_to_age_identity,
    encrypt_to_recipient, pack_encrypted, unpack_encrypted,
};
pub use payment_proof::{
    payment_proof_message, sign_payment_proof, verify_payment_proof, PROOF_MSG_LEN, PROOF_SIG_LEN,
};
pub use slatepack_address::{
    slatepack_address, slatepack_address_ed25519_secret, slatepack_address_to_pubkey, Network,
};

/// Crate version, exposed for runtime debugging.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
