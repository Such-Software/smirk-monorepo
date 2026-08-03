# Smirk Monorepo

Open-source client code for the Smirk multi-currency wallet: Rust crates for chain-specific cryptography, a wasm-bindgen wrapper, and the TypeScript packages that power the browser extension and the desktop app.

## Status

| Component | Status |
|---|---|
| `crates/monero-oxide/` | Working — Monero + Wownero transaction construction, in production via the smirk-extension v0.2.x stack |
| `crates/secp256k1zkp/` | Vendored — Grin's `grin_secp256k1zkp` v0.7.15 + Smirk patches for wasm32. Provides Bulletproofs, Pedersen commitments, aggsig |
| `crates/smirk-wasm/` | Working — single WASM bundle exposing Monero/Wownero/Grin crypto to JS |
| `crates/grin-ext/` | Working — seed derivation, slatepack address (Grim-verified), Schnorr (single + multi-party + adaptor), slate v4 (JSON + compact binary), Pedersen + Bulletproofs, slatepack codec (armor + bin + age encryption), kernels (incl. NRD), full slate construction (standard + invoice flow), transaction wire-format assembly, payment proofs, 6 high-level wallet orchestrators, cross-validated against `grin_wallet_libwallet` 5.4.0 |
| `crates/btc-ext/` | Working — BIP32/BIP39 derivation, P2WPKH (BIP84) + P2TR (BIP86) addresses for BTC + LTC, PSBT construction + signing + extraction. Built on rust-bitcoin |
| `crates/swap-core/` | Stub — atomic swap state machine, implementation pending (v0.4 work) |
| `packages/wasm/` | Working — `@smirk/wasm` TS bindings around the WASM crypto bundle (BTC PSBT, XMR/WOW signing, full Grin surface incl. wallet orchestrators) |
| `packages/core/` | Working — shared TS lib (API client, crypto, BIP-137 signing, address codecs, HD derivation, session-state + wizard scaffold, pendingOutgoing reconciliation, wallet-flow composition) |
| `packages/assets/` | Working — `@smirk/assets` registry: pure-data definitions (decimals, family, capabilities, networks) for every chain Smirk supports. 44 unit tests. |
| `packages/ui/` | Working — `@smirk/ui` shared Preact components: Home (UnifiedBalance, BalanceCard, ActionRow), SendWizard (5 assets incl. Grin interactive Exchange step), GrinRequestWizard, ReceiveScreen, OnboardingWizard, LockScreen, AppShell + BottomNav, ApprovalScreen (dapp prompt UI), theme registry (7 themes incl. retro themes) |
| `packages/dapp-api/` | Working — `@such-software/smirk-dapp-api` transport-agnostic dapp injection: wire protocol, `WalletHandler` dispatcher, page-context `window.smirk` factory, `WalletProvider` / `OriginPermissionStore` / `ApprovalHandler` interfaces. Platform adapters live in `packages/extension/` (and eventually mobile / desktop). |
| `packages/extension/` | Working — Chrome MV3 + Firefox MV3. Keystore + wallet-flow + lockscreen, send (BTC/LTC/XMR/WOW/Grin), receive, social tipping (two-phase create), per-asset detail screen, tri-state balance (confirmed/pending/locked), pendingOutgoing reconciliation. `window.smirk` dapp injection (connect, isConnected, disconnect, getPublicKeys, getAddresses, signMessage for BTC+LTC, requestPayment, claimPublicTip, getBackend) plus a standard NIP-07 `window.nostr` provider (getPublicKey, signEvent, nip04/nip44 encrypt + decrypt, installed only when no other signer claimed the slot) and app-scoped sealed-box keys, with per-origin permissions + standalone approval-window flow + global privacy toggle in Settings. |
| `packages/dapp-browser/` | Working — `@smirk/dapp-browser` embedded-browser shell abstraction. Platform-agnostic `DappBrowserController` + `MockController`; UI consumers (`BrowserShell`, `BrowserUrlBar`, `BrowserTabStrip`) live in `@smirk/ui`. |
| `packages/keymap/` | Working — `@smirk/keymap` cross-platform keyboard-shortcut registry (per-platform bindings, action enum, runtime dispatcher). |
| `packages/swap/` | Working — `@smirk/swap` swap orchestration. `ThorchainSwap` + `TrocadorSwap` aggregator implementations; native adaptor-signature implementations planned v0.4+. |
| `packages/desktop/` | Working — `@smirk/desktop` Tauri 2.x wallet shell + embedded dapp browser. Wraps the extension popup via a `chrome.*` shim (storage backed by tauri-plugin-store). Each browser tab is a borderless `WebviewWindow` positioned over the wallet UI's frame slot. |
| `packages/mobile/` | Not yet populated — Capacitor planned v0.4 |

The legacy browser extension at [Such-Software/smirk-extension](https://github.com/Such-Software/smirk-extension) is frozen at v0.2.x; `packages/extension/` here is the canonical v0.3+ client.

### Backend

v0.3 clients are **backend-agnostic**: they speak to an open, self-hostable server — [`smirk-backend-core`](https://github.com/Such-Software/smirk-backend-core) (chain access + Nostr-native identity / NIP-05 + an optional relay), non-custodial throughout. Run your own, or use the reference public instance at `api.smirk.cash`, where a Smirk username doubles as your `name@smirk.cash` NIP-05 handle. Self-hosting bypasses every registration gate; see that repo's `docs/operations/`.

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
│   ├── core/                 # @smirk/core — API client, crypto, HD derivation, codecs
│   ├── assets/               # @smirk/assets — pure-data registry of every supported chain
│   ├── ui/                   # @smirk/ui — shared Preact components (BalanceCard, SendWizard, OnboardingWizard, BrowserShell, ...)
│   ├── dapp-api/             # @such-software/smirk-dapp-api — transport-agnostic window.smirk wire protocol + WalletHandler
│   ├── dapp-browser/         # @smirk/dapp-browser — embedded-browser shell abstraction (Tauri + Capacitor)
│   ├── keymap/               # @smirk/keymap — cross-platform keyboard-shortcut registry
│   ├── swap/                 # @smirk/swap — swap orchestration (THORChain, Trocador, future native adaptor sigs)
│   ├── extension/            # @smirk/extension — Chrome MV3 + Firefox (the v0.3.0 canonical client)
│   ├── desktop/              # @smirk/desktop — Tauri 2.x wallet shell + embedded dapp browser (v0.3.0)
│   └── e2e/                  # @smirk/e2e: Playwright end-to-end harness, not part of the unit test gate
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
- Node.js 22+ (the package test scripts pass globs to `node --test`, which only expands them from 22)

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

`make test` fans out to `cargo test --workspace` and `npm test --workspaces`, and neither half passes on a bare checkout: the first includes the vendored monero-oxide subtrees' daemon-RPC integration tests, which need a monerod at 127.0.0.1:18081, and the second includes `@smirk/e2e`, whose Playwright suite needs a browser, a running backend and an extension built against it. The gate is `cargo test --workspace --lib` plus `npm test` per unit package.

CI runs on the Gitea Builds runners: see [.gitea/workflows/ci.yml](.gitea/workflows/ci.yml). It builds the WASM bundle and the TypeScript workspace with `make wasm` and `make libs`, but the Rust jobs call `cargo check --workspace --all-targets`, `cargo test --workspace --lib` and `cargo clippy` directly, so the vendored subtrees' daemon-RPC integration tests and upstream lint style do not gate the build. GitHub Actions is disabled for the Such-Software org, so nothing under `.github/workflows/` executes.

## Reproducible from source

For reviewers (Mozilla AMO, App Store, security audits) the goal is `git clone → make build → byte-equivalent output`. Every byte of crypto code lives in `crates/`. The standalone Rust crate `wownero-oxide` is published to crates.io for external consumers, but the monorepo build does not depend on the published version — `crates/monero-oxide/` is the source of truth.

## Companion repos

| Repo | Role |
|---|---|
| [Such-Software/smirk-extension](https://github.com/Such-Software/smirk-extension) | Legacy v0.2.x browser extension. Frozen — `packages/extension/` here is the canonical v0.3+ client. |
| [Such-Software/monero-oxide](https://github.com/Such-Software/monero-oxide) | Standalone fork retained for `wownero-*` crates.io publishing; kept in sync with this monorepo via `git subtree` |
| [monero-oxide/monero-oxide](https://github.com/monero-oxide/monero-oxide) | Upstream — Monero only |

## License

MIT — see [LICENSE](LICENSE).
