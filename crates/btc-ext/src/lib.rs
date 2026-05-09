//! BTC/LTC support for Smirk.
//!
//! Built on rust-bitcoin. Litecoin shares Bitcoin's consensus rules and
//! transaction format byte-for-byte; the only differences that matter for a
//! wallet are address encoding parameters (bech32 HRP, P2PKH/P2SH version
//! bytes) and BIP44 coin type. We parameterize those via [`Network`] and
//! reuse rust-bitcoin's primitives for everything else.
//!
//! Scope (v1): BIP32 derivation, P2WPKH + P2TR address derivation,
//! PSBT-based signing. UTXO selection, fee estimation, and broadcast live
//! in `@smirk/core` (TypeScript) for now.

pub mod address;
pub mod bip32;
pub mod network;
pub mod psbt;

pub use address::{derive_address, AddressKind};
pub use bip32::{derive_xpriv, mnemonic_to_xpriv};
pub use network::Network;
pub use psbt::sign_psbt;
