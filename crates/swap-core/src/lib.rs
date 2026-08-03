//! Adaptor signatures and atomic swap state machine.
//!
//! Stub crate: native adaptor-signature swaps land in v0.4. See
//! `docs/swap-core.md` for the planned shape and the prerequisites.
//! The shape this crate will take:
//!
//! - `adaptor` — Schnorr adaptor signature primitives (secp256k1 for v0.4,
//!   ed25519 for v0.6).
//! - `state_machine` — 7-state swap state machine, persisted to IndexedDB
//!   via the WASM bindings.
//! - `grin` — Grin slate manipulation, NRD kernel construction.
//! - `bitcoin` — 2-of-2 multisig + CSV refund construction.
//! - `litecoin` — re-export of `bitcoin` with LTC parameters.
//! - `xmr` / `wow` — ringct adaptor variants (v0.6).
//!
//! The crate compiles to both native (for tests + tooling) and WASM (consumed
//! through `crates/smirk-wasm`).

/// Placeholder so the crate compiles. Replaced by real types in v0.4.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_set() {
        assert!(!VERSION.is_empty());
    }
}
