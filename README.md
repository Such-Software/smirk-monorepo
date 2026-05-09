# Smirk Monorepo

Open-source client code for the Smirk multi-currency wallet — Rust crates for chain-specific cryptography, a wasm-bindgen wrapper, and (eventually) the TypeScript packages that power the browser extension and mobile app.

## Status

| Component | Status |
|---|---|
| `crates/monero-oxide/` | Working — Monero + Wownero transaction construction, in production via the smirk-extension v0.2.x stack |
| `crates/secp256k1zkp/` | Vendored — Grin's `grin_secp256k1zkp` v0.7.15 + Smirk patches for wasm32. Provides Bulletproofs, Pedersen commitments, aggsig |
| `crates/smirk-wasm/` | Working — single WASM bundle exposing Monero/Wownero/Grin crypto to JS |
| `crates/grin-ext/` | Working — seed derivation, slatepack address (Grim-verified), Schnorr (single + multi-party + adaptor), slate v4, Pedersen + Bulletproofs, slatepack codec (armor + bin + age encryption), kernels (incl. NRD), full slate construction (standard + invoice flow), transaction wire-format assembly, payment proofs |
| `crates/btc-ext/` | Working — BIP32/BIP39 derivation, P2WPKH (BIP84) + P2TR (BIP86) addresses for BTC + LTC, PSBT signing. Built on rust-bitcoin |
| `crates/swap-core/` | Stub — atomic swap state machine, implementation pending (v0.4 work) |
| `packages/wasm/` | Working — `@smirk/wasm` TS bindings around the WASM crypto bundle |
| `packages/core/` | Skeleton — shared TS lib (HD derivation, API client, address codecs); content migrates from smirk-extension |
| `packages/extension/` `packages/mobile/` `packages/desktop/` | Not yet populated — UX shells still upcoming |

The browser extension currently lives at [Such-Software/smirk-extension](https://github.com/Such-Software/smirk-extension). It will be migrated into `packages/extension/` here as the TS workspace is built out.

## Layout

```
smirk-monorepo/
├── crates/                   # Rust workspace
│   ├── monero-oxide/         # vendored — Monero + Wownero transaction library
│   ├── secp256k1zkp/         # vendored — Grin's secp256k1-zkp Rust bindings
│   │                         #   (Bulletproofs, Pedersen, aggsig); patched for wasm32
│   ├── smirk-wasm/           # wasm-bindgen wrapper, single WASM bundle for JS consumers
│   ├── grin-ext/             # Grin / Mimblewimble protocol implementation
│   ├── btc-ext/              # BTC + LTC: BIP32, P2WPKH/P2TR addresses, PSBT signing
│   └── swap-core/            # atomic swap state machine (stub — v0.4)
├── packages/                 # npm workspace (TypeScript)
│   ├── wasm/                 # @smirk/wasm — TS bindings around crates/smirk-wasm/pkg/
│   └── core/                 # @smirk/core — shared HD derivation, API client, codecs
├── docs/                     # design notes per crate
├── Cargo.toml                # flat Rust workspace, all crates listed at root
├── package.json              # npm workspace root
├── tsconfig.base.json        # shared TS compiler config
├── Makefile                  # cross-language build orchestration
└── MONOREPO.md               # developer guide
```

## Build

Requires:
- A recent stable Rust toolchain with the `wasm32-unknown-unknown` target
- A `wasm-bindgen-cli` version matching `Cargo.lock`
- Node.js 20+

```bash
# Cargo workspace
make rust-build      # cargo build --release --workspace
make rust-test       # cargo test --workspace

# WASM bundle (output: crates/smirk-wasm/pkg/)
make wasm

# TypeScript workspace (depends on WASM)
make ts-install      # npm install across packages/*
make ts-typecheck    # tsc --noEmit across packages/*
make ts-build        # tsc -p across packages/*

# Everything (Rust + WASM + TS)
make build
make test
```

CI runs the same `make` targets — see [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Reproducible from source

For reviewers (Mozilla AMO, App Store, security audits) the goal is `git clone → make build → byte-equivalent output`. Every byte of crypto code lives in `crates/`. The standalone Rust crate `wownero-oxide` is published to crates.io for external consumers, but the monorepo build does not depend on the published version — `crates/monero-oxide/` is the source of truth.

## Companion repos

| Repo | Role |
|---|---|
| [Such-Software/smirk-extension](https://github.com/Such-Software/smirk-extension) | Browser extension (active production target until the TS migration lands here) |
| [Such-Software/monero-oxide](https://github.com/Such-Software/monero-oxide) | Standalone fork retained for `wownero-*` crates.io publishing; kept in sync with this monorepo via `git subtree` |
| [monero-oxide/monero-oxide](https://github.com/monero-oxide/monero-oxide) | Upstream — Monero only |

## License

MIT — see [LICENSE](LICENSE).
