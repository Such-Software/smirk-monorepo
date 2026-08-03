# Smirk Monorepo Architecture

This document captures the long-form design decisions behind the
monorepo's package layout, what's shared vs. platform-specific, and
the build-pipeline gotchas that bit us so they don't bite again.

It's authoritative when something in another doc disagrees with it.

---

## Goals

Smirk ships to three surfaces over the v0.3 → v0.5 arc:

- **Extension** (Chrome MV3 + Firefox MV3) — primary today
- **Desktop** (Tauri bundled WebView) — v0.3.0, including the
  embedded dapp browser: one `WebviewWindow` per browser tab on macOS
  and Windows, composited over the wallet UI; an in-process iframe
  controller on Linux, where WebKitGTK loses its compositor surface
  on parent-window resize
- **Mobile** (Capacitor bundled WebView) — v0.4

All three are essentially "Preact app in a WebView." They differ on
storage backends, background process model, platform permissions
(clipboard, biometrics, notifications), and WASM loading rules — but
the wallet logic, UI components, address derivation, signing, and API
client are 100% shared. The monorepo is structured to make that
sharing easy without entangling the shells.

Non-goal: native iOS/Android rewrites. If hardware-backed signing or
deep OS integration ever forces this, it's a v0.5+ conversation.

---

## Package layout

```
smirk-monorepo/
├── packages/
│   ├── assets/        @smirk/assets       — pure-data asset registry
│   ├── core/          @smirk/core         — wallet logic, API, keystore, HD
│   ├── ui/            @smirk/ui           — Preact components (shell-agnostic)
│   ├── wasm/          @smirk/wasm         — WASM facade over `crates/smirk-wasm`
│   ├── swap/          @smirk/swap         — swap orchestration (Trocador aggregator today; ThorchainSwap is a stub; native signing planned)
│   ├── dapp-api/      @such-software/smirk-dapp-api — the page-injected `window.smirk` protocol
│   ├── dapp-browser/  @smirk/dapp-browser — `DappBrowserController` plus tab/navigation types
│   ├── keymap/        @smirk/keymap       — cross-platform shortcut registry
│   ├── extension/     @smirk/extension    — Chrome MV3 / Firefox MV3 shell
│   ├── mobile/        @smirk/mobile       — (future) Capacitor shell
│   ├── desktop/       @smirk/desktop      — Tauri shell
│   ├── e2e/           @smirk/e2e          — Playwright end-to-end suite
│   └── smoke-tests/   @smirk/smoke-tests  — two-wallet mainnet harness
└── crates/
    ├── smirk-wasm/    — Rust→WASM crypto facade (XMR/WOW/BTC/LTC signing, Grin)
    ├── grin-ext/      — Grin / Mimblewimble protocol, 6 wallet orchestrators, slate v4 (JSON+bin), cross-validated against grin-wallet
    ├── btc-ext/       — BTC + LTC: BIP84/BIP86 derivation, PSBT build/sign/extract
    ├── secp256k1zkp/  — vendored grin_secp256k1zkp v0.7.15 + wasm32 patches
    ├── swap-core/     — Rust adaptor-sig primitives (v0.4+)
    └── monero-oxide/  — vendored fork of monero-oxide (Monero + Wownero)
```

### Dependency rule (one-way, top to bottom)

```
shells (extension/mobile/desktop)
    │
    ├──> @smirk/swap ──> @smirk/assets
    │
    ▼
  @smirk/ui ──> @smirk/dapp-browser
    │
    ▼
  @smirk/core ──> @smirk/assets, @smirk/wasm
```

- `@smirk/core` MUST NOT depend on any shell or on `@smirk/ui`.
- `@smirk/ui` MUST NOT depend on shells. Components are presentational
  with injected callbacks; no `chrome.storage` references, no
  `Capacitor` references.
- Shells own platform wiring and inject implementations into core/ui.
- Exception, and a known deviation rather than a pattern to copy: the
  desktop shell does not own its own UI. It imports the extension's
  popup (`@smirk/extension/popup`, resolved by a Vite alias in
  `packages/desktop/vite.config.ts` and not declared as a package
  dependency) and satisfies its `chrome.*` calls with a Tauri-backed
  shim (`packages/desktop/src/chrome-shim.ts`) rather than injecting
  `PlatformStorage`.

If you find yourself wanting to put `chrome.storage` in `@smirk/core`,
you're about to break this. Use the `PlatformStorage` interface.

---

## What's shared vs what's platform-specific

### Shared (lives in `@smirk/core` or `@smirk/ui`)

| Concern | Where | Why shared |
|---|---|---|
| HD derivation, BIP39 | `@smirk/core/hd` | Pure math; same on every platform |
| Keystore + encryption | `@smirk/core/keystore` | Pure crypto; storage is injected |
| API client (auth, balances, prices) | `@smirk/core/api` | Pure HTTP/fetch |
| Auth-bootstrap, balance-fetch flow | `@smirk/core/wallet-flow` | Composition over `@smirk/core/api` |
| Address validation, encoding | `@smirk/core/address` | Pure |
| Asset registry (decimals, families, capabilities) | `@smirk/assets` | Pure data |
| Preact components (Home, Send, Receive, Onboarding, Settings, etc.) | `@smirk/ui` | Render the same in any WebView |
| Popup state machine, route persistence, wizard scaffold | `@smirk/core/state` | Generic — wired to a `PlatformStorage` |
| Swap orchestration interface + TrocadorSwap | `@smirk/swap` | HTTP only |
| Grin slate orchestration (S1/S2/S3 + I1/I2/I3) | `packages/extension/src/popup/grin-flows.ts` (extension-side; folds into `@smirk/core` when mobile lands) | Calls into `@smirk/wasm` `grin.*` for crypto |
| Pending-outgoing tri-state reconciliation | `@smirk/core/state/pending-outgoing` | Generic across all five chains; per-family input identifiers |

### Platform-specific (lives in `packages/<shell>/`)

| Concern | Why platform-specific | Abstraction |
|---|---|---|
| Persistent storage backend | chrome.storage.local / Capacitor Preferences / Tauri filesystem-or-keychain | `PlatformStorage` interface in `@smirk/core/state/platform` |
| Ephemeral / session storage | chrome.storage.session / in-memory only / OS keychain | `PlatformStorage` (different instance) |
| Background process | MV3 service worker / Capacitor background plugin / Tauri Rust backend | `WalletTimers` interface in `@smirk/core/state/platform` (declared, unimplemented) |
| Clipboard | `navigator.clipboard` works in extension/desktop; Capacitor plugin on mobile | inject `onCopy` callback into `ReceiveScreen` |
| Notifications | `chrome.notifications` / Capacitor Push / Tauri Notifications | `WalletNotifications` interface in `@smirk/core/state/platform` (declared, unimplemented) |
| Biometric unlock | not in extension / Capacitor biometric on mobile / Tauri biometric crate on desktop | `BiometricUnlock` interface, optional |
| Pop-out window | `chrome.windows.create` on extension; resize on mobile/desktop | already abstracted via `AppShell`'s `onPopOut` prop |
| WASM loading | bundled asset URL on extension; Capacitor file:// on mobile; Tauri file:// on desktop | `initialize(moduleOrPath?)` already handles |

---

## Build-pipeline gotchas (known, documented, don't re-step on these)

### wasm-bindgen target choice

**Problem:** wasm-bindgen 0.2.95+ with `--target web` emits
`import * from "env"` placeholders at the top of the JS glue. The
`env` module isn't real — it's a marker that a bundler (Webpack with
the wasm plugin, etc.) is expected to resolve. Vite/Rollup don't do
that out of the box; the popup tries to instantiate WASM and gets
`LinkError: Import #0 "env" "malloc": function import requires a
callable`.

**Resolution options** (decreasing complexity, increasing portability):

1. **`--target no-modules`** — single-file IIFE-style glue. No `import`
   statements. Self-contained. Works in any WebView (extension,
   Capacitor, Tauri). Slight payload increase. **Recommended for
   v0.3.**
2. **`--target web` + Vite plugin** (`vite-plugin-wasm` or hand-rolled
   `resolveId` for `env`). More moving parts.
3. **`--target bundler` + Webpack** — works but requires us to ship a
   Webpack pipeline alongside Vite. No.
4. **Pin to wasm-bindgen 0.2.92** — last version without the env
   placeholders. Works but tech-debts us into an old wasm-bindgen.

The build script lives at `crates/smirk-wasm/build.sh`. Whoever
touches it: stay on `--target no-modules` until the bundler ecosystem
catches up.

### MV3 popup CSP

**Problem:** Chrome MV3's default extension CSP is
`script-src 'self'; object-src 'self'`. That blocks WebAssembly
compilation entirely → popup logs
`Compiling or instantiating WebAssembly module violates the following
Content Security Policy directive…`. The failure is silent: the
try/catch around WASM init swallows the throw and balance computation
degrades.

**Resolution:** Add to manifest:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

Both `manifest.json` and `manifest.firefox.json` carry this. Do not
remove it: without `'wasm-unsafe-eval'` the Monero / Wownero / Grin
code paths fail to load.

### `import * from "env"` stub aliasing

**Don't.** An earlier attempted fix aliased the `env` module
specifier to an empty-exports JS stub. This makes the JS glue *load*,
but `__wbg_get_imports()` then references the aliased empty module as
the source of WASM's `env.malloc`/`env.free`, and `WebAssembly.instantiate`
throws `LinkError`. Use `--target no-modules` instead.

### chrome.storage.session structured clone

**Problem:** `JSON.stringify(Infinity)` returns `"null"`, so a "never
expires" sentinel of `Infinity` round-tripped through a JSON-based
storage layer becomes invalid. We use `chrome.storage.session` which
uses structured cloning (preserves `Infinity` correctly), but it's
fragile to depend on. The session-cache for opt-in auto-unlock has no
"never" option: `clampAutoLockMinutes` bounds the lifetime to
`AUTO_LOCK_MAX_MINUTES` (24h), and a legacy sentinel read from storage
collapses to that cap.

### LWS admin endpoint hard rules

These are operator-side invariants enforced by the backend's typed
wrappers. They live here because client code that interacts with the
backend should know what shape it relies on:

1. `/rescan` is **backwards-only**. `height > current scan_height` is
   undefined behavior; the daemon may exit cleanly leaving the system
   inactive.
2. `modify_account_status` mid-scan corrupts LMDB metadata
   (`MDB_NOTFOUND`). Status changes must drain the scanner first.

Don't `curl` the admin endpoints from operator shells for
non-diagnostic operations.

---

## Backend federation

The wallet is backend-agnostic: the default public instance, a
self-hosted `smirk-backend-core`, or another operator's.

- The selected instance is durable state, stored under
  `BACKEND_CONFIG_KEY` in `@smirk/core/api/backend-config`. Every JS
  context (service worker, offscreen runner, popup) reads it and
  re-applies it at boot, so they never diverge on which backend they
  are talking to.
- `/capabilities` is the per-instance contract: advertised chains,
  `nip05_domain`, relay and feed config, registration gates. The
  wallet gates features on it rather than deriving them from the
  backend URL.
- Switching instances drops the JWT (a token minted by one backend is
  meaningless to another), invalidates the memoized capabilities, and
  clears the bootstrap, dapp and balance caches. It also resets the
  messaging relay set, which is a module global that would otherwise
  survive the switch and keep publishing to the previous operator's
  relays.

`packages/ui/src/components/BackendPicker.tsx` is the selection UI;
the teardown lives in the shell's `onBackendSwitched` handler.

---

## Cross-cutting abstractions for mobile/desktop

`WalletTimers` and `WalletNotifications` are declared in
`@smirk/core/state/platform` and re-exported from `@smirk/core/state`.
No shell implements either: the extension calls `chrome.alarms` and
`chrome.notifications` directly
(`packages/extension/src/background/dm-watch.ts`), and the desktop
shim polyfills neither. `CredentialStore` is not declared anywhere.

### `WalletTimers` interface

One-shot scheduler, not a periodic poller. It fires the registered
callback even when the wallet UI surface is closed or backgrounded;
auto-lock is the current caller.

```ts
interface WalletTimers {
  scheduleOnce(name: string, delayMs: number): Promise<void>;
  cancel(name: string): Promise<void>;
  onTimer(listener: (name: string) => void): () => void;
}
```

Implementations:
- Extension: wraps `chrome.alarms`.
- Mobile: Capacitor `BackgroundTask` plugin.
- Desktop: Tauri's `tauri::async_runtime::spawn` + interval.

Without this, mobile/desktop can't notify users of incoming tips
when the wallet is backgrounded.

### `CredentialStore` interface (auth tokens, biometric-protected secrets)

JWT lives in `globalThis.__smirk_api_token__` today. Fine in a popup
that lives <30s before being re-authed. Mobile/desktop apps stay
foregrounded for hours; need a real session-token store that:

- Survives app backgrounding
- Cleared on lock / OS-level logout
- Optionally biometric-gated to read

Implementations:
- Extension: in-memory only (popup re-auths on open — fast enough)
- Mobile: iOS Keychain / Android Keystore via Capacitor
- Desktop: OS keychain (Tauri keychain plugin)

### `WalletNotifications` interface (push + local notifications)

For incoming tips, completed swaps, etc. There is no permission-request
method; `id` lets the caller replace or dismiss a specific notification
later.

```ts
interface WalletNotifications {
  show(input: { id: string; title: string; body: string; iconUrl?: string }): Promise<void>;
  dismiss(id: string): Promise<void>;
}
```

Implementations: `chrome.notifications`, Capacitor `LocalNotifications`,
Tauri `Notification`.

---

## Desktop platform: Tauri, not Electron

Decision: **Tauri**, with `WebviewWindow::new()` available for an
in-app dapp browser later. Will not switch to Electron.

**Context:** Smirk is building a first-party non-EVM dapp ecosystem
(smirk.cash, play.wowne.ro, monerogue.app). An in-app browser that
pre-injects `window.smirk` is *more* valuable for Smirk than for
typical wallets, because Smirk publishes the dapps the wallet
launches. ETH L1 may be added in v0.5+, which separately re-opens
WalletConnect v2 — but that's WebSocket relay, not browser-bundled.

**Why Tauri over Electron:**

| | Electron | **Tauri** |
|---|---|---|
| Bundle | 100–300 MB | 5–20 MB |
| Idle memory | 150–300 MB | 50–80 MB |
| Chromium consistency | Yes (bundled) | Per-platform WebView |
| Native Rust IPC | No (Node bridge) | Yes (`tauri::command`) |
| Dapp browser pattern | Mature (`BrowserView`) | `WebviewWindow::new()` |

The Rust-IPC win is structural — bypassing WASM for the crypto path
on desktop is a v0.5+ optimization Electron forecloses. The
bundle/memory wins are immediate.

**Per-platform WebView caveat:**

| Platform | Engine | Status |
|---|---|---|
| Windows | WebView2 (Chromium) | First-class — same engine as Edge |
| macOS | WKWebView (WebKit) | First-class — Safari engine |
| Linux | WebKitGTK | Weakest link — historical bugs in Web Crypto, WebGL, newer JS features |

WebKitGTK already costs the Linux build a separate browser path
(`packages/desktop/src/main.ts` selects an iframe-backed controller
there) and a 120 ms resize debounce on the native path, both because
the embedded WebView loses its compositor surface on parent-window
resize (tauri#7537, wry#1727). What is still unmeasured is
third-party dapp compatibility under WebKitGTK: measure that before
anyone reopens the Electron decision.

**`window.smirk` injection** works via Tauri's `initialization_script()`,
which runs before page DOM. Standard MetaMask content-script pattern.

**No-go reasoning for Electron** is recorded so future contributors
don't reopen the question on first-principles: the bundle+memory
hit, Chromium CVE cadence, and the loss of native Rust IPC together
outweigh the consistency win for our ecosystem shape. Revisit only
on hard data (e.g., a critical third-party dapp that won't run on
WebKitGTK with no workaround).

---

## Open questions

- **Lazy-load WASM per-asset?** Split `crates/smirk-wasm` into
  `crates/smirk-wasm-monero`, `crates/smirk-wasm-grin`, etc. and only
  ship/load what the user actively uses. Tradeoff: bundle size (3.5MB
  → potentially 1MB primary + lazy) vs build complexity. Worth doing
  post-v0.3 if mobile bundle size becomes a real complaint. Not urgent.
- **Service worker offscreen documents** for long-running tasks
  (atomic-swap state machines)? Required if SW lifetimes turn out to
  be too aggressive for swap-round timing.
- **Pop-out window as default on extension?** Chrome MV3 popup is
  capped at 600px. Mobile/desktop have no such cap. We could detect
  small popup mode and auto-suggest popout. Punted — UX call.

---

## Tooling

- **Package manager:** `npm` workspaces. Not `pnpm`. Build commands:
  `npm run build:chrome -w @smirk/extension` (or `build:firefox`).
- **TS config:** `tsconfig.base.json` at the root, each package extends.
  Strict mode on, `exactOptionalPropertyTypes: true`.
- **Test runner:** `node --test` with `tsx` for `.ts` imports.
- **WASM build:** `crates/smirk-wasm/build.sh` runs `wasm-bindgen
  --target no-modules` and drops output in `crates/smirk-wasm/pkg/`.
  Build with `make wasm` from the monorepo root.
- **Backend:** separate repo (`smirk-backend-core`). Rust/Axum.
  `cargo build --release --bin smirk-backend-core`.

## Audit posture cross-references

The OVK and LWS migration left several patterns worth not
re-introducing. The public, actionable one lives in this doc under
"Build-pipeline gotchas": WASM env imports and MV3 CSP.

When porting code from the legacy `smirk-extension` v0.2.x codebase
into a monorepo package, treat it as a rewrite target rather than a
copy-paste source. Several patterns (fresh per-tx OVK, MV3 CSP,
derived build ordering) have to be re-architected to fit this repo.
