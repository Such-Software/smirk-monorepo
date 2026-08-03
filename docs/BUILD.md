# Building Smirk

How to build the Smirk clients from this monorepo: the **browser extension**
(Chrome + Firefox) and the **desktop app** (Tauri). The backend lives in the
separate `smirk-backend-core` repo and is not built here.

## Prerequisites

- **Node.js 22+** and npm. Node 20 is not enough: the package test scripts pass
  a glob to `node --test`, and `node --test` only expands globs from 22. This is
  why CI pins 22.
- **Rust** (stable), required for **both** clients. The browser extension does
  not just need Rust for the desktop app: the wallet's cryptography ships as a
  WebAssembly bundle built from the `crates/` Rust workspace, and the extension
  build copies that bundle in. Install the toolchain via [rustup](https://rustup.rs),
  then add the WebAssembly target and `wasm-bindgen`:

  ```bash
  rustup target add wasm32-unknown-unknown
  # Install the wasm-bindgen CLI at the version pinned in Cargo.lock (a version
  # mismatch fails the build). Find it with:
  #   grep -A1 'name = "wasm-bindgen"' Cargo.lock | grep version
  cargo install wasm-bindgen-cli --version <version-from-Cargo.lock>
  ```

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

## Build the WASM bundle first

The wallet's chain cryptography is a WebAssembly bundle produced from the Rust
workspace. It is git-ignored (not checked in), so a fresh clone has to build it
before anything that imports `@smirk/wasm`, which includes the extension:

```bash
make wasm                # -> crates/smirk-wasm/pkg/  (needs Rust + wasm32 target)
```

Skipping this is the most common fresh-clone failure: `@smirk/wasm` resolves to
an empty `pkg/` and the extension loads without working crypto.

## Shared libraries build first

The apps import the workspace libraries (`@smirk/core`, `@smirk/ui`,
`@smirk/assets`, `@smirk/wasm`, …) from their **built `dist/`**, so build the
libraries before an app. `tsc -p` emits, so each library needs its dependencies'
`dist/` already on disk:

```bash
make libs                # every @smirk/* library dist, in derived dependency order
```

Root `npm run build` walks the workspaces alphabetically rather than in
dependency order, so on a fresh clone `@smirk/core` compiles before `@smirk/wasm`
has a `dist/` to resolve against; it appears to work only when a stale `dist/` is
already there. CI builds with `make libs` for that reason.

## Browser extension

The `make` targets are the reliable path: they build the WASM bundle, then every
workspace library in derived dependency order, then the extension. Nothing to
sequence by hand:

```bash
make ext-chrome    # dist/ with the Chrome MV3 manifest
# or
make ext-firefox   # dist/ with the Firefox manifest
```

The npm scripts build only the extension itself and assume the WASM bundle and
the workspace `dist/`s are already built, so run `make wasm` (and `make libs`)
first if you use them directly:

```bash
make wasm                                     # once, if not already built
npm run build:chrome  -w @smirk/extension     # dist/ with the Chrome MV3 manifest
# or
npm run build:firefox -w @smirk/extension     # dist/ with the Firefox manifest
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
(`smirk-desktop`) and, under `bundle/`, the platform artifacts as configured by
`bundle.targets` in `src-tauri/tauri.conf.json` (Linux: AppImage; macOS: `.app`;
Windows: NSIS). The **first** build compiles the full Rust webview stack and can
take several minutes.

For iterative development (hot-reload, no bundle):

```bash
npm run tauri:dev -w @smirk/desktop
```

## Verify

```bash
npm run typecheck        # all workspaces

# The unit gate, as CI runs it. npm has no workspace exclusion, so the packages
# are listed: add new ones here.
for pkg in @smirk/assets @smirk/core @such-software/smirk-dapp-api \
           @smirk/dapp-browser @smirk/extension @smirk/keymap \
           @smirk/swap @smirk/ui; do
  npm test -w "$pkg"
done
```

Root `npm test` is not the unit gate: `--workspaces --if-present` also reaches
`@smirk/e2e`, whose test script is `playwright test`, which needs a browser, a
running backend, and an extension built against that backend, and aborts on its
own preflight. Run the Playwright suite in its own environment with
`npm run e2e -w @smirk/e2e`.
