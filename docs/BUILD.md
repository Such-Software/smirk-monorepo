# Building Smirk

> Status: stable · Updated 2026-09-27 · Applies to: Smirk client builds and release candidates

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

- **Desktop only: Linux system libraries** (Tauri v2 webview stack). On
  Debian/Ubuntu:

  ```bash
  sudo apt update
  sudo apt install -y libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
    libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev \
    build-essential curl wget file libssl-dev libgtk-3-dev
  ```

  (macOS needs Xcode command-line tools; Windows needs the MSVC build tools +
  WebView2; see the Tauri prerequisites guide.)

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

Output: `packages/extension/dist/`, a loadable **unpacked** extension.

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

Output: `packages/desktop/src-tauri/target/release/`, the raw binary
(`smirk-desktop`) and, under `bundle/`, the platform artifacts as configured by
`bundle.targets` in `src-tauri/tauri.conf.json` (Linux: AppImage and Debian package; macOS: `.app`;
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
           @smirk/swap @smirk/ui @smirk/desktop; do
  npm test -w "$pkg"
done
node --test scripts/__tests__/*.test.mjs
```

Root `npm test` is not the unit gate: `--workspaces --if-present` also reaches
`@smirk/e2e`, whose test script is `playwright test`, which needs a browser, a
running backend, and an extension built against that backend, and aborts on its
own preflight. Run the Playwright suite in its own environment with
`npm run e2e -w @smirk/e2e`.

## Release candidates and signatures

The app repository owns client source and build inputs. Use the declared source
remote and reviewed release ingress. A successful candidate build does not
publish a release, approve a store submission, or change source authority.

Both release jobs require `TROCADOR_API_KEY` in build custody and refuse before
building when it is absent. Local development may leave swaps disabled. The
affiliate input is readable in the distributed client bundle; keep its value
out of source, commands and logs. Reproduction requires the same build inputs.

Build from one clean, reviewed source commit with the required source checks
green. The protected Builds branch receives a two-parent ingress wrapper whose
second parent is that source commit and whose tree is identical. Fleet retains
both identities. The candidate workflow accepts only an explicit dispatch on
`Builds/smirk-monorepo` main with `expected_sha` equal to the actual wrapper
commit. Its admission job verifies the parent/tree proof before any platform
job can consume signing credentials. Tags do not start candidate builds. The
[candidate workflow](../.gitea/workflows/desktop-build.yml) stages extension,
macOS, Windows and Linux artifacts internally. Each carries generated provenance
binding its digests to the exact build commit and tree, approved source parent,
and previous ingress parent. Public tags and release
assets are not moved or replaced by that workflow.

Collect one successful workflow run, then verify and sign its complete set.
Set `SMIRK_SIGNING_KEY` to the independently verified full signing subkey
fingerprint, optionally followed by `!`. This public selector is required for
both signing and verification; credential values remain in custody.

```sh
scripts/fetch-release-artifacts.sh VERSION --run-id RUN_ID --expect-commit FULL_BUILD_WRAPPER_SHA --dest /path/to/candidate
scripts/sign-release.sh VERSION --bundle-dir /path/to/candidate --expect-commit FULL_BUILD_WRAPPER_SHA
scripts/sign-release.sh VERSION --bundle-dir /path/to/candidate --expect-commit FULL_BUILD_WRAPPER_SHA --verify
```

The collector uses the enrolled local Gitea credential without placing its value
in command arguments or output. It verifies HTTPS, refuses cross-host redirects,
and validates archive paths before extraction. Missing, expired or inaccessible
artifacts are failures, even when the workflow says it succeeded. Collection
reads the exact wrapper and source-parent trees from Gitea and compares every
artifact receipt to that binding. `source_commit` in the receipt names the
actual checked-out build commit; `approved_source_commit` names canonical source.
The matching Fleet dispatch receipt establishes canonical landing: the source
parent must equal its reviewed GitHub main pin. A tree-identical wrapper alone
does not prove that landing. Do not substitute one identity for the other. No release-tag
fallback substitutes another run's output.

The signer requires all platforms from the expected commit and source tree. It
checks required deliverables and their hashes before creating signatures, and
never borrows an archive from the working checkout. Verification requires GPG's
machine-readable valid signature from that exact subkey, including refusal of
expired, revoked or ambiguous evidence. macOS candidates must pass
Developer ID, expected team, hardened runtime, notarization staple and Gatekeeper
checks. Windows candidates must pass the signing broker's Authenticode,
publisher and timestamp checks. See the [desktop owner](../packages/desktop/README.md)
for platform behavior and the [extension release process](../packages/extension/RELEASE.md)
for reproduction and store submission.

Before Windows compilation, `scripts/ci/windows-signing-preflight.mjs` reads the
breaker, queue, keepalive history and named broker task metadata. Missing,
malformed, future or older-than-nine-hour warm evidence refuses. A stopped
broker also refuses. If the runner cannot read its task metadata, liveness is
unknown and the build refuses; the operator must resolve observation access
through the Fleet-owned signing setup. A warm timestamp records an earlier
successful operation, not current token login. This preflight never signs,
starts a task or supplies a PIN. Present token usability remains unknown until
the actual candidate is signed and its signature verified.

Credential enrollment belongs to the reviewed custody procedure. Routine builds
consume enrolled credentials. Store submissions and public uploads remain
separate release actions against the declared target. Retain source admission,
candidate hashes, signatures, platform checks and submission receipts in
`~/journal`. Report staged, submitted, approved and publicly available as distinct
states.

## Build and release checklist

- [ ] Build tools match the pinned inputs and candidate toolchain record.
- [ ] Required source checks passed for the reviewed source commit.
- [ ] Every candidate names that commit and the same source tree.
- [ ] Platform signatures, provenance, checksums and detached signatures verify.
- [ ] Final packages pass installation and relevant wallet-operation checks.
- [ ] Extension source reproduction and store disclosures match the package.
- [ ] Publication target and actual release state are recorded privately.
