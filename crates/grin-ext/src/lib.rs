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

pub mod seed;

pub use seed::{mnemonic_to_extended_private_key, ExtendedPrivateKey};

/// Crate version, exposed for runtime debugging.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
