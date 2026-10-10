//! Experimental peer-to-peer swap protocols.
//!
//! The optional BasicSwap module provides offline message validation only.
//! No settlement, relay connection, wallet signing or WASM binding is enabled.

#[cfg(feature = "basicswap-interop")]
pub mod basicswap;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
