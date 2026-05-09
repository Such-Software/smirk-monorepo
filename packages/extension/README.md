# @smirk/extension — skeleton

Browser-extension shell (Chrome MV3 + Firefox) for Smirk, in the monorepo.

**Current state:** scaffolding. The substantive popup, background, and
content-script code lives at
[Such-Software/smirk-extension](https://github.com/Such-Software/smirk-extension)
and migrates in over multiple commits — this package proves the build
pipeline works (Vite → `@smirk/core` + `@smirk/wasm` → MV3 popup +
service worker).

## Layout

```
packages/extension/
├── manifest.json            # Chrome MV3 manifest
├── manifest.firefox.json    # Firefox MV3 manifest (uses scripts[] not service_worker)
├── popup.html               # Popup entry HTML
├── vite.config.ts           # Build config (copies WASM bundle into dist/)
├── tsconfig.json            # Extends ../../tsconfig.base.json
└── src/
    ├── popup/               # Preact popup UI
    ├── background/          # MV3 service worker (Chrome) / event page (Firefox)
    └── content/             # Content scripts (TBD)
```

## Build

The extension depends on the WASM bundle and the workspace TS packages
all being built first. From the monorepo root:

```bash
make wasm                         # crates/smirk-wasm/pkg/  (Rust → wasm-bindgen)
npm install                       # workspace install
npm run build --workspace @smirk/wasm
npm run build --workspace @smirk/core
npm run build --workspace @smirk/extension       # produces dist/
npm run build:chrome --workspace @smirk/extension
npm run build:firefox --workspace @smirk/extension
```

Load the unpacked extension from `packages/extension/dist/`.

## Migration plan

Source of truth is the
[smirk-extension](https://github.com/Such-Software/smirk-extension)
v0.2.x stack. The migration replaces local `src/lib/*` imports with
`@smirk/core` and `@smirk/wasm`:

| Legacy path                       | Replacement                            |
|-----------------------------------|----------------------------------------|
| `src/lib/api/*`                   | `@smirk/core` (`api`, `SmirkApi`)      |
| `src/lib/crypto.ts`               | `@smirk/core` (PBKDF2, ECDH, BIP-137)  |
| `src/lib/hd.ts`                   | `@smirk/core` (mnemonic, deriveAllKeys)|
| `src/lib/address.ts`              | `@smirk/core` (btcAddress, xmrAddress, ...) |
| `src/lib/grin/*` (MWC vendor)     | `@smirk/wasm` `grin.*` namespace       |
| `src/lib/monero-crypto.ts`        | `@smirk/wasm` `monero.*` namespace     |
| `src/lib/xmr-tx.ts` (JS XMR tx)   | `@smirk/wasm` `monero.signTransaction` |
| `src/lib/btc-tx.ts` (@scure JS)   | `@smirk/wasm` `bitcoin.*` namespace    |

The shell pieces (popup, background, content scripts, manifest) port
verbatim minus the import paths.

## Why a skeleton first

The full extension migration is multi-day work and touches every file.
Landing the skeleton first proves:

1. The Vite + monorepo path resolution works (`@smirk/core` imports
   resolve to the workspace package, not a published version).
2. The WASM bundle copy step lands the bytes in the right place
   (`dist/wasm/`) for the MV3 service worker to fetch at runtime.
3. The Chrome and Firefox manifests build into a loadable unpacked
   extension (sanity check before committing to wholesale UI move).

Subsequent commits port real features one section at a time.
