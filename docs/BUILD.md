# Building Smirk

How to build the Smirk clients from this monorepo: the **browser extension**
(Chrome + Firefox) and the **desktop app** (Tauri). The backend lives in the
separate `smirk-backend-core` repo and is not built here.

## Prerequisites

- **Node.js 20+** and npm.
- **Rust** (stable) — only for the desktop app. Install via [rustup](https://rustup.rs).
- **Desktop only — Linux system libraries** (Tauri v2 webview stack). On
  Debian/Ubuntu:

  ```bash
  sudo apt update
  sudo apt install -y libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
    libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev \
    build-essential curl wget file libssl-dev libgtk-3-dev
  ```

  (macOS needs Xcode command-line tools; Windows needs the MSVC build tools +
  WebView2 — see the Tauri prerequisites guide.)

Install workspace dependencies once from the repo root:

```bash
npm install
```

## Shared libraries build first

The apps import the workspace libraries (`@smirk/core`, `@smirk/ui`,
`@smirk/assets`, `@smirk/wasm`, …) from their **built `dist/`**, so build the
libraries before an app. The simplest path builds every workspace:

```bash
npm run build            # builds all @smirk/* library dists (repo root)
```

## Browser extension

```bash
npm run build:chrome  -w @smirk/extension   # dist/ with the Chrome MV3 manifest
# or
npm run build:firefox -w @smirk/extension   # dist/ with the Firefox manifest
```

Output: `packages/extension/dist/` — a loadable **unpacked** extension.

- **Chrome:** `chrome://extensions` → enable Developer mode → **Load unpacked**
  → select `packages/extension/dist/`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary
  Add-on** → select `packages/extension/dist/manifest.json`.

The two manifests target the same `dist/`, so build the one you want last (or
zip each: `cd packages/extension/dist && zip -r ../smirk-extension.zip .`).

## Desktop app (Tauri)

Build the frontend, then the native bundle:

```bash
npm run build       -w @smirk/desktop       # vite frontend -> dist/
npm run tauri:build -w @smirk/desktop        # native app + installers
```

Output: `packages/desktop/src-tauri/target/release/` — the raw binary
(`smirk-wallet`) and, under `bundle/`, the platform installers (Linux:
AppImage + `.deb`; macOS: `.dmg`; Windows: NSIS). The **first** build compiles
the full Rust webview stack and can take several minutes.

For iterative development (hot-reload, no bundle):

```bash
npm run tauri:dev -w @smirk/desktop
```

## Verify

```bash
npm run typecheck        # all workspaces
npm test                 # all workspaces
```
