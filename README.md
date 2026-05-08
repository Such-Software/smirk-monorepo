# Smirk Monorepo

Open-source client code for the Smirk multi-currency wallet — Rust crates for chain-specific cryptography, a wasm-bindgen wrapper, and (eventually) the TypeScript packages that power the browser extension and mobile app.

## Status

| Component | Status |
|---|---|
| `crates/monero-oxide/` | Working — Monero + Wownero transaction construction, in production via the smirk-extension v0.2.x stack |
| `crates/smirk-wasm/` | Working — exposes Monero/Wownero crypto + initial Grin functions to JS |
| `crates/grin-ext/` | Active development — Grin protocol reimplementation in progress |
| `crates/swap-core/` | Stub — atomic swap primitives, implementation pending |
| `packages/` | Not yet populated — TypeScript migration is still upcoming |

The browser extension currently lives at [Such-Software/smirk-extension](https://github.com/Such-Software/smirk-extension). It will be migrated into `packages/extension/` here once the Grin reimplementation reaches feature parity with the existing vendored MWC wallet stack.

## Layout

```
smirk-monorepo/
├── crates/                   # Rust workspace
│   ├── monero-oxide/         # vendored — Monero + Wownero transaction library
│   ├── smirk-wasm/           # wasm-bindgen wrapper, single WASM bundle for JS consumers
│   ├── grin-ext/             # Grin / Mimblewimble protocol implementation
│   └── swap-core/            # atomic swap primitives (stub)
├── packages/                 # npm workspace (empty — TypeScript migration upcoming)
├── docs/                     # design notes per crate
├── Cargo.toml                # flat Rust workspace, all crates listed at root
├── Makefile                  # cross-language build orchestration
└── MONOREPO.md               # developer guide
```

## Build

Requires a recent stable Rust toolchain with the `wasm32-unknown-unknown` target and a `wasm-bindgen-cli` version matching `Cargo.lock`.

```bash
# Cargo workspace
make rust-build      # cargo build --release --workspace
make rust-test       # cargo test --workspace

# WASM bundle (output: crates/smirk-wasm/pkg/)
make wasm

# Everything
make build
make test
```

The WASM build script auto-detects the right `wasm-bindgen-cli` version. CI runs the same `make` targets — see [.github/workflows/ci.yml](.github/workflows/ci.yml).

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
