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
pub mod schnorr;
pub mod secp256k1;
pub mod seed;
pub mod slate;
pub mod slate_builder;
pub mod slatepack;
pub mod slatepack_address;
pub mod slatepack_encryption;

pub use kernel::{KernelFeatures, NRD_MAX_RELATIVE_HEIGHT};
pub use slate_builder::{
    sender_init_s1, sender_init_s1_with_id, SenderContext, SenderInitOutput, SenderInitParams,
};

pub use bulletproof::{
    bullet_proof_create, bullet_proof_rewind, bullet_proof_verify, pedersen_commit,
};

pub use schnorr::{
    aggregate_partials, final_signature, partial_sign, partial_verify, point_add, point_sum,
    sign as schnorr_sign, sign_with_nonce, verify as schnorr_verify, Signature,
};
pub use secp256k1::public_key_from_secret_key;
pub use seed::{mnemonic_to_extended_private_key, ExtendedPrivateKey};
pub use slate::{parse_slate_v4, serialize_slate_v4, SlateStateV4, SlateV4};
pub use slatepack::{
    armor as slatepack_armor, dearmor as slatepack_dearmor, SlatepackBin, SlatepackMode,
    SlatepackVersion,
};
pub use slatepack_encryption::{
    decrypt_with_secret, ed25519_pub_to_age_recipient, ed25519_secret_to_age_identity,
    encrypt_to_recipient, pack_encrypted, unpack_encrypted,
};
pub use slatepack_address::{slatepack_address, Network};

/// Crate version, exposed for runtime debugging.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
