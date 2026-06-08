# @smirk/extension

Chrome MV3 + Firefox MV3 wallet extension — the canonical Smirk
client. v0.3.0+.

The legacy v0.2.x extension lives at
[Such-Software/smirk-extension](https://github.com/Such-Software/smirk-extension);
it is frozen. New work happens here.

## Wallet flows shipping in v0.3.0

- Wallet create / import / unlock / lock / destroy (encrypted keystore
  in `chrome.storage.local`, opt-in N-minute auto-lock session cache).
- Per-asset send + receive: BTC, LTC, XMR, WOW, Grin (slatepack +
  encrypted Grin → Grin via address).
- Social tipping (BTC/LTC/XMR/WOW/Grin) — two-phase create with
  backend-side draft + client IndexedDB tip-key backup for recovery.
- Per-asset detail screen with price sparkline + activity history
  (chain transactions + sent tips with inline clawback).
- `window.smirk` dapp injection: connect, signMessage (BTC + LTC),
  isConnected, disconnect, getPublicKeys, getAddresses. Per-origin
  permission store + standalone approval-popup window.
- Privacy: global toggle in Settings to disable `window.smirk` on
  websites (closes [smirk-extension#1](
  https://github.com/Such-Software/smirk-extension/issues/1)
  short-term ask).

Tracked for v0.3.x / v0.4 follow-up:

- `requestPayment` from dapp → wallet send-wizard handoff.
- `claimPublicTip` via dapp.
- `signMessage` for XMR / WOW / Grin (ed25519 path).
- Standalone "Sent Tips" Settings screen — the `SentTipsScreen`
  component exists but isn't mounted in v0.3.0 (replaced by inline
  asset-row clawback). Either wire it or remove the dead component.

## Layout

```
packages/extension/
├── manifest.json            # Chrome MV3 manifest
├── manifest.firefox.json    # Firefox MV3 manifest (uses scripts[] not service_worker)
├── popup.html               # Popup entry HTML
├── vite.config.ts           # Build config (copies WASM bundle, bundles content.ts + inject.ts as IIFEs)
├── tsconfig.json            # Extends ../../tsconfig.base.json
└── src/
    ├── popup/               # Preact popup UI (action popup + approval-window mode)
    ├── background/          # MV3 service worker
    │   └── dapp/            # Dapp bridge: dispatch, provider, approval, permissions, inject-policy
    ├── content/             # Content-script bridge (page ↔ SW), gated by inject-policy
    └── inject/              # Page-context bootstrap (defines window.smirk; bundled as IIFE)
```

## Build

The extension depends on the WASM bundle and the workspace TS packages
all being built first. From the monorepo root:

```bash
make wasm                                # crates/smirk-wasm/pkg/  (Rust → wasm-bindgen)
npm install                              # workspace install
npm run build -w @smirk/wasm
npm run build -w @smirk/assets
npm run build -w @smirk/core
npm run build -w @such-software/smirk-dapp-api
npm run build -w @smirk/ui
npm run build:chrome -w @smirk/extension # or build:firefox
```

The `Makefile` at the monorepo root has shortcuts (`make ext-chrome`,
`make ext-firefox`) that run these in order.

Load the unpacked extension from `packages/extension/dist/`.

## Architecture notes

- **MV3 SW threat model.** The service worker is evictable and
  intentionally holds NO secrets at rest. The unlocked seed lives in
  the popup process; the SW reads a public-only cache the popup
  writes to `chrome.storage.local` on unlock. See
  `src/background/dapp/provider.ts` and `docs/SECURITY_AUDIT.md`.
- **Dapp approval flow.** Sensitive ops (signMessage, requestPayment,
  claimPublicTip) round-trip through a `chrome.windows.create` popup
  window — the action popup closes on focus loss and would lose any
  long-running approval mid-decision. The popup-window context holds
  the unlocked wallet, performs the operation, writes the result
  back via `chrome.storage.session` for the SW to relay.
- **Cross-platform reuse.** `@such-software/smirk-dapp-api` is transport-agnostic:
  the same `WalletHandler` + `ApprovalHandler` interfaces drive the
  extension AND the v0.3.0 Tauri desktop embedded browser (each
  embedded webview gets the same `window.smirk` injection script,
  with responses routed back through Tauri events). The Capacitor
  mobile build will reuse the same interfaces in v0.4 — only the
  message-transport adapter is platform-specific
  (`chrome.runtime.sendMessage` ↔ `__TAURI__.event` ↔
  `Capacitor.WebView`).
