# Monorepo Developer Guide

Where things live, how they fit together, and how to make changes without breaking the build.

## Why a monorepo?

Smirk's client code is split across two languages (Rust + TypeScript), three deliverables (extension, mobile app, shared core), and several Rust crates that need to evolve together. The previous arrangement — separate repos for `smirk-extension`, `smirk-wasm-monero`, and the `monero-oxide` fork — made cross-cutting changes painful and gave Mozilla / App Store reviewers an opaque WASM blob with no clear provenance.

This monorepo solves both. One `git clone`, one `make build`, byte-reproducible output.

## Crates (Rust)

### `crates/monero-oxide/`

A 16-crate vendored workspace — our fork of [monero-oxide](https://github.com/monero-oxide/monero-oxide) that adds Wownero transaction support alongside the original Monero support.

- **Library names** (as you `use` them in Rust) stayed `monero_*` for compatibility: `monero_oxide`, `monero_ed25519`, `monero_clsag`, etc.
- **Crates.io package names** are `wownero-*` to avoid collision with the upstream packages: `wownero-oxide`, `wownero-ed25519`, etc.
- **Dual-coin support is built in** — `RctType::ClsagBulletproofPlus` (Monero, type 6, ring 16) and `RctType::WowneroClsagBulletproofPlus` (Wownero, type 8, ring 22) coexist in the same library.

Full background, including the upstream-merge workflow for the eventual fcmp++ hardfork: [docs/WOWNERO_OXIDE.md](https://github.com/Such-Software/smirk-backend/blob/main/docs/WOWNERO_OXIDE.md) (in the backend repo).

### `crates/smirk-wasm/`

The wasm-bindgen wrapper that exposes the crypto from `monero-oxide` (and eventually `swap-core`) to JavaScript. Single WASM bundle (~380 KB) consumed by both the extension and the Capacitor mobile app.

Public API surface (see `src/lib.rs`):

- `validate_address`, `parse_tx`
- `derive_key_image`, `derive_output_key_image`, `compute_key_image`
- `estimate_fee`, `sign_transaction`

The `coin: "xmr" | "wow"` field on transaction params is what selects between Monero (ring 16, RCT type 6) and Wownero (ring 22, RCT type 8) at runtime.

### `crates/swap-core/`

Adaptor-signature primitives + cross-chain atomic swap state machine. Stub in session 1; the body of v0.4 work lives here.

Will compile to both:
- WASM (consumed via `crates/smirk-wasm`) for the wallet UI
- Native targets for any future server-side validation tooling

## Packages (TypeScript)

Populated in session 2 of the monorepo migration. Provisional layout:

- `packages/core` — HD derivation, API client, address codecs (today's `smirk-extension/src/lib/`)
- `packages/wasm` — thin re-export of `crates/smirk-wasm`'s wasm-pack output, with TS types
- `packages/extension` — browser extension (Chrome MV3 + Firefox)
- `packages/mobile` — Capacitor app (iOS + Android)

## Git subtree workflow

Both `crates/monero-oxide/` and `crates/smirk-wasm/` were imported via `git subtree`. Their full upstream history is preserved.

### Pulling fixes from upstream monero-oxide

```bash
# Add the upstream remote (one-time setup, may already be present)
git remote add upstream-monero-oxide https://github.com/monero-oxide/monero-oxide.git

# Pull and squash-merge upstream changes into our subtree
git fetch upstream-monero-oxide
git subtree pull --prefix=crates/monero-oxide upstream-monero-oxide main --squash
```

Conflicts will land in `crates/monero-oxide/Cargo.toml` files (the package-rename diffs). Resolution rule: keep our `wownero-*` package names, take upstream's version bumps and structural changes. See `crates/monero-oxide/PUBLISHING.md`.

### Pushing changes back to standalone monero-oxide fork (for crates.io publish)

The `wownero-*` crates are still published from the standalone [Such-Software/monero-oxide](https://github.com/Such-Software/monero-oxide) repo so external Rust consumers can depend on them. To sync local monorepo changes back:

```bash
git remote add fork-monero-oxide git@github.com:Such-Software/monero-oxide.git
git subtree push --prefix=crates/monero-oxide fork-monero-oxide main
```

## Build orchestration

`make build` runs (in order):

1. `cargo build --release --workspace` — every Rust crate
2. `wasm-pack build crates/smirk-wasm --target web --release` — WASM bundle
3. `npm run build --workspaces --if-present` — TypeScript packages (when populated)

Individual targets:
- `make wasm` — just the WASM step
- `make test` — `cargo test --workspace` + `npm test --workspaces`
- `make clean` — wipes `target/`, `crates/smirk-wasm/pkg/`, `node_modules/`, all package `dist/`

## Adding a new Rust crate

1. `mkdir -p crates/your-crate/src && cd crates/your-crate`
2. `cargo init --lib` (or copy a sibling crate's `Cargo.toml` skeleton)
3. Add the path to `[workspace.members]` in the root `Cargo.toml`
4. `cargo check --workspace` from the repo root to verify

## Adding a new TypeScript package

(Once the npm workspace is wired up in session 2.)

1. `mkdir -p packages/your-package && cd packages/your-package`
2. `npm init -y` and adjust `name` to `@smirk/your-package`
3. The root `package.json` already has `"workspaces": ["packages/*"]` — `npm install` from root will pick it up

## Reproducibility for reviewers

For Mozilla AMO, App Store / Play Store, or security audit reviewers:

```bash
git clone https://github.com/Such-Software/smirk-monorepo.git
cd smirk-monorepo
make build
# Output bundles in:
#   crates/smirk-wasm/pkg/                 — WASM blob + JS bindings
#   packages/extension/dist/               — extension build output (Chrome + Firefox)
#   packages/mobile/{android,ios}/         — Capacitor native projects
```

Every byte of crypto code is in `crates/`. No precompiled blobs sourced from npm. No build-time downloads beyond the locked dependency manifests (`Cargo.lock`, `package-lock.json`).
