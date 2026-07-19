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
  embedded dapp browser (one `WebviewWindow` per browser tab,
  composited over the wallet UI)
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
│   ├── swap/          @smirk/swap         — swap orchestration (ThorchainSwap, Trocador aggregator today; native signing planned)
│   ├── extension/     @smirk/extension    — Chrome MV3 / Firefox MV3 shell
│   ├── mobile/        @smirk/mobile       — (future) Capacitor shell
│   └── desktop/       @smirk/desktop      — Tauri shell
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
    ▼
  @smirk/ui  ──┐
               ▼
       @smirk/core ──> @smirk/assets, @smirk/wasm
               │
               ▼
       @smirk/swap
```

- `@smirk/core` MUST NOT depend on any shell or on `@smirk/ui`.
- `@smirk/ui` MUST NOT depend on shells. Components are presentational
  with injected callbacks; no `chrome.storage` references, no
  `Capacitor` references.
- Shells own platform wiring and inject implementations into core/ui.

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
| Swap orchestration interface + ThorchainSwap | `@smirk/swap` | HTTP only |
| Grin slate orchestration (S1/S2/S3 + I1/I2/I3) | `packages/extension/src/popup/grin-flows.ts` (extension-side; folds into `@smirk/core` when mobile lands) | Calls into `@smirk/wasm` `grin.*` for crypto |
| Pending-outgoing tri-state reconciliation | `@smirk/core/state/pending-outgoing` | Generic across XMR/WOW/Grin |

### Platform-specific (lives in `packages/<shell>/`)

| Concern | Why platform-specific | Abstraction |
|---|---|---|
| Persistent storage backend | chrome.storage.local / Capacitor Preferences / Tauri filesystem-or-keychain | `PlatformStorage` interface in `@smirk/core/state/platform` |
| Ephemeral / session storage | chrome.storage.session / in-memory only / OS keychain | `PlatformStorage` (different instance) |
| Background process | MV3 service worker / Capacitor background plugin / Tauri Rust backend | `BackgroundScheduler` (to be defined; see Open Questions) |
| Clipboard | `navigator.clipboard` works in extension/desktop; Capacitor plugin on mobile | inject `onCopy` callback into `ReceiveScreen` |
| Notifications | `chrome.notifications` / Capacitor Push / Tauri Notifications | (TBD — `Notifier` interface) |
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
Content Security Policy directive…`. Silent failure: my code's
try/catch swallows the throw and balance computation degrades.

**Resolution:** Add to manifest:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

This is present in both `manifest.json` and `manifest.firefox.json`
and has been since 2026-05-11. Don't remove it — without
`'wasm-unsafe-eval'` the Monero / Wownero / Grin code paths fail to
load.

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
fragile to depend on. The session-cache for opt-in auto-unlock uses
`Number.MAX_SAFE_INTEGER` as the "never" sentinel for portability.

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

## Cross-cutting abstractions to land before v0.4 mobile/desktop

These don't exist yet. Listing them so they're not surprises when
mobile/desktop shells start landing.

### `BackgroundScheduler` interface

Polls balances on a cadence even when no popup is open.

```ts
interface BackgroundScheduler {
  schedulePeriodic(name: string, intervalMin: number, handler: () => Promise<void>): Promise<void>;
  cancel(name: string): Promise<void>;
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

### `Notifier` interface (push + local notifications)

For incoming tips, completed swaps, etc.

```ts
interface Notifier {
  request(): Promise<'granted' | 'denied' | 'default'>;
  notify(opts: { title: string; body: string; tag?: string }): Promise<void>;
}
```

Implementations: `chrome.notifications`, Capacitor `LocalNotifications`,
Tauri `Notification`.

---

## Desktop platform — Tauri vs Electron (decided 2026-05-11)

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

Because we control our own dapps, the WebKitGTK gap matters only when
the wallet also browses third-party EVM dapps post-ETH-L1. Test
top targets (Uniswap, OpenSea, etc.) against WebKitGTK during the
v0.4 Tauri scaffolding before committing. If the gap is unacceptable
at that point, the Electron decision can be revisited — but only
once measurements force it.

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

The 2026-05-10 OVK + LWS migration era surfaced several patterns
worth not re-introducing. The public, actionable one lives in this
doc under "Build-pipeline gotchas": WASM env imports and MV3 CSP.

When porting code from the legacy `smirk-extension` v0.2.x codebase
into a monorepo package, treat it as a rewrite target rather than a
copy-paste source. Several patterns (fresh per-tx OVK, MV3 CSP,
derived build ordering) have to be re-architected to fit this repo.
