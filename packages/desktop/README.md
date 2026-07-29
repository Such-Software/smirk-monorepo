# @smirk/desktop — Tauri desktop shell

Smirk Wallet packaged as a native desktop app for macOS, Windows, and Linux.

## Architecture

The desktop shell is intentionally thin. We wrap the same Preact wallet UI
that the browser extension ships ([`packages/extension/src/popup`](../extension/src/popup))
in a Tauri 2.x webview, with a small `chrome.*` compatibility shim
([`src/chrome-shim.ts`](src/chrome-shim.ts)) that polyfills the four
extension-API surfaces the popup uses:

| Extension API              | Desktop polyfill                            |
| -------------------------- | ------------------------------------------- |
| `chrome.storage.local`     | `@tauri-apps/plugin-store` (filesystem)     |
| `chrome.storage.session`   | In-memory `Map` (cleared on window close)   |
| `chrome.storage.onChanged` | Custom EventTarget around the two backends  |
| `chrome.runtime.getURL`    | Identity transform — Tauri serves from `/`  |
| `chrome.windows.create`    | No-op — extension "pop out" only; not used by browser tabs |

## Known limitations (v0.3.0)

- **Background auto-lock is degraded.** The extension uses
  `chrome.alarms` to fire auto-lock even when the popup is closed.
  Tauri has no equivalent yet, and `chrome-shim.ts` does not polyfill
  `chrome.alarms`. Auto-lock fires correctly while the wallet window
  is open; it does not fire if you minimise / hide the window. A
  `WalletTimers` abstraction in `@smirk/core` is the planned fix.
- **Tip-arrival notifications are silent.** Same shape — the shim
  does not polyfill `chrome.notifications`. Inbox still updates on
  open; only the OS-level notification doesn't fire.
- **`chrome.windows.create`** ("pop out the wallet to its own
  window") is a no-op. The desktop is already a single first-class
  window, so the action-popup "pop out" button does nothing here.
- **Network egress is not enforced by CSP.** `connect-src` is
  `'self' https: wss:`. It previously listed specific Smirk hosts,
  which silently broke self-hosting: the backend URL is chosen by the
  user at RUNTIME, CSP is static at BUILD time, so a federated backend
  at `https://backend.example.org` was blocked by the webview before
  the request ever left. A wallet that cannot talk to the user's own
  server is not federated, so the allowlist had to go.
  This brings desktop to parity with the extension, whose manifest has
  no `connect-src` restriction at all. `script-src` / `object-src` stay
  tight, and those are the ones that matter for XSS.
  Real enforcement returns with the transport work: once egress runs
  through Rust (`tauri-plugin-websocket` and an HTTP counterpart), the
  allowlist lives there, where it can be checked against the user's
  configured backend instead of a compile-time constant. See
  `docs/private/TRANSPORTS.md`.

## Development

Prerequisites: Rust toolchain, Node 20+, `cargo install tauri-cli --version "^2"`.

```sh
# From the monorepo root:
make wasm                                # builds smirk-wasm pkg/
npm install                              # workspace install
cd packages/desktop
npm run tauri:dev                        # launches dev window
```

The Vite dev server runs on port 1420; Tauri picks it up from
`tauri.conf.json::build.devUrl`.

## Build

```sh
npm run tauri:build
```

Outputs bundle artifacts to `src-tauri/target/release/bundle/`. Targets are
read from `tauri.conf.json::bundle.targets` (currently
`["appimage", "app", "dmg", "nsis"]` — produces `.app` + `.dmg` on macOS,
`.msi` / `.exe` on Windows, `.AppImage` on Linux). `.deb` and `.rpm` are
intentionally omitted; AppImage is the agreed Linux delivery format.

## Signing & notarization

- **macOS:** Apple Developer signing identity goes in
  `tauri.conf.json::bundle.macOS.signingIdentity`. Notarization needs
  `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` env vars. Both null in
  the committed config — the maintainer wires them per-environment.
- **Windows:** unsigned for v0.3.0 (SmartScreen will warn on first launch).
- **Linux:** unsigned `.AppImage`; users verify against the repository's
  SHA256SUMS file.

## Updater

`tauri.conf.json::plugins.updater.active` is `false` and the `pubkey` field
is a placeholder. To activate:

1. Generate a keypair: `cargo tauri signer generate -w ~/.tauri/smirk.key`
2. Paste the public key into `tauri.conf.json::plugins.updater.pubkey`.
3. Set `active: true`.
4. Keep the private key offline; load it as `TAURI_PRIVATE_KEY` env at
   release time.

The update server endpoint pattern follows Tauri's default; the actual
release backend lives at `releases.smirk.cash/desktop/...`.

## Tracked for v0.4

- No deep links (`smirk://` URL handler) — tip-claim URLs work via
  clipboard only.
- No system tray.
- No autostart-on-login option.
- In-app browser polish. The Rust plugin and the `BrowserShell` UI
  already support multiple tabs and per-tab `window.smirk`
  injection — what defers to v0.4 is the visual tab-strip surface,
  bookmarks persistence, and history-backed URL-bar autocomplete.
