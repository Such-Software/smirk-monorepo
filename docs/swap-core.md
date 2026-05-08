# swap-core

Adaptor-signature primitives and atomic swap state machine. Stub crate today; implementation lands when the underlying chain crates (`grin-ext`, the Monero/Wownero stack in `monero-oxide`, and Bitcoin/Litecoin support) provide enough surface for cross-chain swaps to compose cleanly.

## Goal

Smirk wallet users will be able to execute peer-to-peer atomic swaps directly from the wallet, without an order-matching coordinator, custodial escrow, or per-trade fees collected by Smirk. The cryptographic glue between chains is adaptor signatures over the shared signature scheme of the participating chains:

- secp256k1 + Schnorr for swaps involving Grin, Bitcoin, Litecoin
- ed25519 for swaps involving Monero, Wownero

The `swap-core` crate will house both — and the state machine that drives a swap from setup through completion (or refund).

## Status

Stub. The crate exists in the workspace so future work is "add to existing crate" rather than "set up new crate." `lib.rs` exposes only `VERSION`.

## Planned shape

Public surface, when populated:

- `adaptor` module — adapt / extract operations for Schnorr (secp256k1) and Ed25519
- `state_machine` module — N-state cross-chain swap state machine, persistable so a swap survives client restarts
- per-chain modules wrapping the relevant crates (`grin-ext`, `monero-oxide`, plus the eventual Bitcoin/Litecoin support) with the swap-specific signature variants

Compiles to both native (for tests + tooling) and WASM (consumed via `crates/smirk-wasm/` from the wallet UI).

## Design references

- Andrew Poelstra's "Scriptless Scripts" notes
- BIP-340 + adaptor-signature literature
- [Comit Network's `xmr-btc-swap`](https://github.com/comit-network/xmr-btc-swap) — production Rust XMR↔BTC adaptor-signature implementation, useful reference for the ed25519/ringct side
- [grin-wallet "simple contracts"](https://github.com/cekickafa/grin-wallet/tree/simple_contracts_restructured_v3) — reference for Grin's interactive multi-party transaction state machine
