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

### `crates/secp256k1zkp/`

Vendored copy of [`grin_secp256k1zkp`](https://github.com/mimblewimble/rust-secp256k1-zkp) v0.7.15 — Grin's fork of `rust-secp256k1-zkp`. Provides Bulletproofs (BP, the original — Grin uses this, not BP+), Pedersen commitments, and aggsig that the upstream `secp256k1-zkp` Rust crate doesn't bind.

The crate is FFI to `libsecp256k1-zkp` (C). The C source is vendored in-tree at `crates/secp256k1zkp/depend/secp256k1-zkp/` (the original release used a git submodule; we replaced it with the contents at the pinned commit so monorepo clones are self-contained).

**Smirk patches applied** (all labeled with `// Smirk patch:` comments for clean upstream sync):
- `wasm-sysroot/` directory with minimal libc forward-declaration headers so clang's wasm32 frontend can compile the C source
- `build.rs` adds `wasm-sysroot` as an include path when targeting wasm32
- Rust sources alias `size_t` to `usize` locally (the upstream `libc` crate doesn't expose `libc::size_t` on wasm32-unknown-unknown); `core::ffi::*` replaces `libc::c_int` / `c_uchar` / `c_uint` / `c_void`

Consumed by `crates/grin-ext/` via path dep.

### `crates/smirk-wasm/`

The wasm-bindgen wrapper. Single WASM bundle that exposes:

- **Monero/Wownero functions:** `validate_address`, `parse_tx`, `derive_key_image`, `derive_output_key_image`, `compute_key_image`, `estimate_fee`, `sign_transaction`. The `coin: "xmr" | "wow"` field on transaction params selects between Monero (ring 16, RCT type 6) and Wownero (ring 22, RCT type 8) at runtime.
- **Grin functions:** seed/key derivation, slatepack address (Grim-compatible), Schnorr sign/verify, slate v4 parse/round-trip, Pedersen commit, Bulletproof create/verify/rewind. See [docs/grin.md](docs/grin.md) for the full export list.
- **BTC/LTC functions:** `btc_derive_address` (P2WPKH or P2TR for either chain, mainnet or testnet), `btc_sign_psbt` (base64 PSBT in/out). Network passed as a string (`"btc-mainnet"`, `"ltc-mainnet"`, etc.).

Output: `crates/smirk-wasm/pkg/` (gitignored, produced by `make wasm`).

### `crates/grin-ext/`

Smirk's Grin / Mimblewimble protocol implementation. Built up from primitives (HMAC-SHA512, k256 / secp256k1zkp, ed25519, etc.) rather than forked from upstream `grin-wallet`, because we need to extend it with features that don't exist upstream (atomic-swap adaptor signatures, NRD-kernel time-locks, custom slate workflows).

Currently shipped: seed → extended key, BIP32 child derivation, slatepack address (Grim-verified), Schnorr sign/verify, SlateV4 types + JSON round-trip, Pedersen + Bulletproofs. Still in flight: slatepack codec, slate construction, NRD kernels, multi-party Schnorr aggregation, adaptor sigs. See [docs/grin.md](docs/grin.md) for the full status table.

### `crates/btc-ext/`

Smirk's BTC and LTC support, built on [rust-bitcoin](https://github.com/rust-bitcoin/rust-bitcoin) v0.32. One crate covers both chains because Litecoin is byte-compatible with Bitcoin at the consensus and transaction layer; the only differences that matter to a wallet are address-encoding parameters, which we model in [`network.rs`](../crates/btc-ext/src/network.rs).

Currently shipped:
- **BIP32 / BIP39 derivation** — mnemonic → master xprv → child xprv along an arbitrary BIP32 path. Test-vectorized against the Trezor canonical all-abandon mnemonic.
- **Address derivation** — P2WPKH (BIP84, `bc1q…` / `ltc1q…` / `tb1q…` / `tltc1q…`) and P2TR (BIP86 key-only, `bc1p…` / `ltc1p…`). bech32 / bech32m encoding done via the `bech32` crate so we can use LTC's HRPs (`ltc`, `tltc`) — rust-bitcoin's own `Address` type is BTC-only.
- **PSBT signing** — base64-in / base64-out. Walks per-input `bip32_derivation` maps; signs every input whose origin matches the supplied xprv, leaves the rest untouched.

Test vectors include the canonical BIP84 and BIP86 reference values from the BIPs themselves. See `crates/btc-ext/src/{bip32,address}.rs` for the unit tests.

UTXO selection, fee estimation, and tx broadcast are deliberately out of scope here — those live in `@smirk/core` (TypeScript, infrastructure-aware) and call this crate via the WASM bridge.

### `crates/swap-core/`

Adaptor-signature primitives and atomic swap state machine. Currently a stub — implementation lands when the protocol design has solidified. See [docs/swap-core.md](docs/swap-core.md).

## Packages (TypeScript)

npm workspace at the monorepo root. All packages share `tsconfig.base.json` and use vanilla `tsc` for builds (no bundler at the lib level — bundling happens at the consumer level via Vite for the extension, etc.).

### `packages/wasm/` — `@smirk/wasm`

Thin TypeScript wrapper around the wasm-bindgen output at `crates/smirk-wasm/pkg/`. Exposes every Grin/Monero/Wownero/aggregate function organized into `monero` and `grin` namespaces with TypeScript types. Consumers must call `await initialize()` once before using.

```ts
import { initialize, grin } from '@smirk/wasm';
await initialize();
const addr = grin.slatepackAddress(mnemonic, 0, 'mainnet');
```

### `packages/core/` — `@smirk/core`

Shared TypeScript code consumed by the browser extension, mobile app, and desktop app:
- HD key derivation (BIP-39 + per-asset derivation paths)
- API client for the Smirk backend (auth, social tipping, LWS, etc.)
- Address codecs (BTC, LTC, XMR/WOW, Grin)
- Shared types (wallet state, slate v4 helpers, asset metadata)

Currently a skeleton — content migrates in over multiple commits from the legacy `Such-Software/smirk-extension` repo's `src/lib/`.

### Planned (not yet populated)

- `packages/ui/` — shared Preact components used by extension + mobile + desktop
- `packages/extension/` — Chrome MV3 + Firefox manifest, popup, background, content scripts
- `packages/mobile/` — Capacitor app (iOS + Android)
- `packages/desktop/` — Tauri app (Win/Mac/Linux)

## Git subtree workflow

Three crates are imported via `git subtree`, preserving full upstream history:

| Path | Upstream | Purpose |
|---|---|---|
| `crates/monero-oxide/` | `monero-oxide/monero-oxide` (forked at `Such-Software/monero-oxide`) | Monero + Wownero transaction library |
| `crates/smirk-wasm/` | `Such-Software/smirk-wasm` | wasm-bindgen wrapper |
| `crates/secp256k1zkp/` | `mimblewimble/rust-secp256k1-zkp` | Grin's secp256k1-zkp Rust bindings |

### Pulling Monero upstream changes

```bash
git fetch upstream-monero-oxide
git subtree pull --prefix=crates/monero-oxide upstream-monero-oxide main --squash
```

Conflicts will land in `crates/monero-oxide/**/Cargo.toml` (the package-rename diffs) and possibly the root `Cargo.toml` if upstream changed their workspace structure. Resolution rule: keep `wownero-*` package names locally, take upstream's version bumps and structural changes. See `crates/monero-oxide/PUBLISHING.md`.

### Pulling secp256k1zkp upstream changes

```bash
git remote add upstream-secp256k1zkp https://github.com/mimblewimble/rust-secp256k1-zkp.git  # one-time
git fetch upstream-secp256k1zkp
git subtree pull --prefix=crates/secp256k1zkp upstream-secp256k1zkp main --squash
```

Then re-apply our wasm32 patches if upstream conflicts (look for `// Smirk patch:` comments). The patches are localized to four Rust files (`ffi.rs`, `lib.rs`, `aggsig.rs`, `pedersen.rs`) and one `build.rs` change, plus the in-tree `wasm-sysroot/` directory.

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
