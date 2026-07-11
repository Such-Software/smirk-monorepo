# swap-core

Adaptor-signature primitives and atomic swap state machine. Stub crate today; implementation lands when the underlying chain crates (`grin-ext`, the Monero/Wownero stack in `monero-oxide`, and Bitcoin/Litecoin support) provide enough surface for cross-chain swaps to compose cleanly.

## Goal

Smirk wallet users will be able to execute peer-to-peer atomic swaps directly from the wallet, without an order-matching coordinator, custodial escrow, or per-trade fees collected by Smirk. The cryptographic glue between chains is adaptor signatures over the shared signature scheme of the participating chains:

- secp256k1 + Schnorr for swaps involving Grin, Bitcoin, Litecoin
- ed25519 for swaps involving Monero, Wownero

The `swap-core` crate will house both — and the state machine that drives a swap from setup through completion (or refund).

## Status

Stub. The crate exists in the workspace so future work is "add to existing crate" rather than "set up new crate." `lib.rs` exposes only `VERSION`.

The two main dependencies the swap engine will need are now both available in the workspace:

- **`crates/grin-ext/`** — Schnorr sign/verify over secp256k1, BLAKE2b challenge hash, slate v4 parse/serialize. Adaptor-signature variants of Schnorr signing are a clean extension on top of what's there.
- **`crates/secp256k1zkp/`** — Bulletproofs, Pedersen commitments, and aggsig from Grin's libsecp256k1-zkp. Provides the byte-equivalent-to-grin-wallet primitives needed for swap-side commitments and proofs.

## v0.4 prerequisites (do first)

Ordered TODO; item 1 is a hard security gate before ANY multiparty signing runs.

1. **Nonce lifecycle state machine (blocker).** Today `grin-ext`'s `partial_sign` / `adaptor_partial_sign` are stateless functions that take a caller-supplied `secret_nonce`. Nothing stops the caller from signing twice with the same nonce, which discloses the signing key outright (`x = (s - s') / (e - e')`); BIP 327 (MuSig2) warns about exactly this. Before wiring any swap flow to these primitives, build a nonce state machine that generates a fresh secret nonce, hands it out for exactly one `partial_sign`, and then destroys it, so reuse is unrepresentable at the type level rather than a caller convention. Do not expose the raw stateless `partial_sign` to swap orchestration code. (Interim: both functions now carry `# Safety` doc-warnings; the leftover DEBUG secret-logging in `partial_sign` was removed 2026-07-11.)
2. Persist swap + nonce state so an in-flight swap survives a client restart without ever re-deriving or reusing a consumed nonce.
3. Adaptor adapt/extract wired through the state machine (not called ad hoc).

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
