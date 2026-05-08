# Monorepo Developer Guide

Where things live, how they fit together, and how to make changes without breaking the build.

## Why a monorepo?

Smirk's client code is split across two languages (Rust + TypeScript) and several Rust crates that need to evolve together. Shipping the chain-specific cryptography and the consumers in separate repos made cross-cutting changes painful and gave external reviewers (Mozilla AMO, App Store, security audits) opaque WASM blobs with no clear provenance.

The monorepo solves both. One `git clone`, one `make build`, byte-reproducible output, every byte of crypto code in `crates/`.

## Crates (Rust)

### `crates/monero-oxide/`

A 19-crate vendored workspace — a fork of [monero-oxide](https://github.com/monero-oxide/monero-oxide) that adds Wownero transaction support alongside the original Monero support. All workspace members are listed in the flat root `Cargo.toml`; the inner workspace declaration was removed to comply with Cargo's nesting rules.

- **Library names** (as you `use` them in Rust) are `monero_*` — `monero_oxide`, `monero_ed25519`, `monero_clsag`, etc.
- **Crates.io package names** are `wownero-*` to avoid collision with the upstream packages.
- **Dual-coin support is built in.** `RctType::ClsagBulletproofPlus` (Monero — type 6, ring 16) and `RctType::WowneroClsagBulletproofPlus` (Wownero — type 8, ring 22) coexist; the consumer picks at runtime.

See [docs/monero-wownero.md](docs/monero-wownero.md) for design notes.

### `crates/smirk-wasm/`

The wasm-bindgen wrapper. Single WASM bundle that exposes:

- **Monero/Wownero functions:** `validate_address`, `parse_tx`, `derive_key_image`, `derive_output_key_image`, `compute_key_image`, `estimate_fee`, `sign_transaction`. The `coin: "xmr" | "wow"` field on transaction params selects between Monero (ring 16, RCT type 6) and Wownero (ring 22, RCT type 8) at runtime.
- **Grin functions:** `grin_derive_extended_key`, `grin_ext_version`. The Grin surface is being built out incrementally — see [docs/grin.md](docs/grin.md).

Output: `crates/smirk-wasm/pkg/` (gitignored, produced by `make wasm`).

### `crates/grin-ext/`

Smirk's Grin / Mimblewimble protocol implementation. Reimplemented from primitives (HMAC-SHA512, secp256k1, ed25519, etc.) rather than forked from upstream `grin-wallet`, because we need to extend it with features that don't exist upstream (atomic-swap adaptor signatures, NRD-kernel time-locks).

Built up incrementally across releases — see [docs/grin.md](docs/grin.md) for what's currently shipped vs what's still in flight.

### `crates/swap-core/`

Adaptor-signature primitives and atomic swap state machine. Currently a stub — implementation lands when the protocol design has solidified. See [docs/swap-core.md](docs/swap-core.md).

## Packages (TypeScript)

Empty for now. The browser extension currently lives at [Such-Software/smirk-extension](https://github.com/Such-Software/smirk-extension); migration into `packages/extension/` follows once `crates/grin-ext/` reaches feature parity with the existing Grin stack in that repo.

Planned layout when populated:

- `packages/core/` — HD derivation, API client, address codecs (extracted from today's `smirk-extension/src/lib/`)
- `packages/wasm/` — thin TS re-export of `crates/smirk-wasm/pkg/` with TS types
- `packages/extension/` — Chrome MV3 + Firefox extension
- `packages/mobile/` — Capacitor app (iOS + Android)

## Git subtree workflow

`crates/monero-oxide/` and `crates/smirk-wasm/` were imported via `git subtree`, preserving full upstream history.

### Pulling Monero upstream changes

```bash
git fetch upstream-monero-oxide
git subtree pull --prefix=crates/monero-oxide upstream-monero-oxide main --squash
```

Conflicts will land in `crates/monero-oxide/**/Cargo.toml` (the package-rename diffs) and possibly the root `Cargo.toml` if upstream changed their workspace structure. Resolution rule: keep `wownero-*` package names locally, take upstream's version bumps and structural changes. See `crates/monero-oxide/PUBLISHING.md`.

### Pushing back to the standalone monero-oxide fork (for crates.io publish)

The `wownero-*` crates are published from the standalone [Such-Software/monero-oxide](https://github.com/Such-Software/monero-oxide) repo so external Rust consumers can depend on them.

```bash
git subtree push --prefix=crates/monero-oxide fork-monero-oxide main
```

## Remotes

The repo expects three remotes for the subtree workflow:

```bash
git remote add origin git@github.com:Such-Software/smirk-monorepo.git
git remote add upstream-monero-oxide https://github.com/monero-oxide/monero-oxide.git
git remote add fork-monero-oxide git@github.com:Such-Software/monero-oxide.git
```

A fresh clone has only `origin`; add the other two if you'll be doing subtree sync work.

## Build orchestration

```bash
make build       # cargo build --release --workspace + wasm-bindgen
make test        # cargo test --workspace
make check       # fast cargo check (no binaries)
make wasm        # just the WASM bundle
make clean       # wipe target/, pkg/, node_modules/
```

`make wasm` calls `cargo build --target wasm32-unknown-unknown --release` then `wasm-bindgen --target web` against the output. The wasm-bindgen lib version in `Cargo.lock` and the installed `wasm-bindgen-cli` version must match exactly — CI installs the matching CLI version automatically; locally use `cargo install -f wasm-bindgen-cli --version <version-from-Cargo.lock>` if you hit a version-skew error.

## Adding a new Rust crate

1. `mkdir -p crates/your-crate/src`
2. Create `crates/your-crate/Cargo.toml` (use a sibling crate as a template)
3. Add `crates/your-crate` to `[workspace.members]` in the root `Cargo.toml`
4. `cargo check --workspace` to verify

## Reproducibility for reviewers

For Mozilla AMO, App Store, Play Store, or security-audit reviewers:

```bash
git clone https://github.com/Such-Software/smirk-monorepo.git
cd smirk-monorepo
make build
# WASM bundle: crates/smirk-wasm/pkg/
```

Every byte of crypto code is in `crates/`. No precompiled blobs sourced from npm. No build-time downloads beyond the locked dependency manifests (`Cargo.lock`).
