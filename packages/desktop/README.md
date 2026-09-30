# Smirk desktop shell

> Status: stable · Updated 2026-09-27 · Applies to: the Tauri desktop client and its release inputs

The desktop app packages the shared wallet UI for macOS, Windows, and Linux.
The app repository owns client behavior and build inputs. Fleet owns production
release activation and credential custody.

## Runtime

The entry point installs host services before importing the
[shared popup](../extension/src/popup). The desktop shell provides these
extension API equivalents:

| Extension API | Desktop behavior |
| --- | --- |
| `chrome.storage.local` | Tauri filesystem store; writes flush before returning |
| `chrome.storage.session` | Process memory; cleared when the window closes |
| `chrome.storage.onChanged` | Change events from both storage adapters |
| `chrome.runtime.getURL` | Paths served from the packaged frontend |
| `chrome.runtime.sendMessage` | Background hints resolve without a background worker |
| `chrome.runtime.connect` | Rejects because the extension jobs worker is unavailable |
| `chrome.windows.create` | The wallet already has its own window; no additional window |
| `chrome.tabs.create` | Rejects extension-only wallet-tab requests |

Trocador requests use the bundled HTTP plugin, installed before the popup mounts.
The first quote therefore uses native HTTP. Its capability scope permits only
`https://api.trocador.app/*`. A missing transport reports a connection failure;
webview fetch cannot replace it because Trocador's CORS policy blocks that path.

Desktop Vite reads its own environment, including values supplied by CI. It does
not read `packages/extension/.env`. The reviewed Trocador affiliate configuration
uses `VITE_TROCADOR_API_KEY`; an absent value keeps swaps disabled. A missing
setting and a failed transport are separate failures.

The embedded browser uses native webviews on macOS and Windows and an iframe
controller on Linux. See [embedded browser design](../../docs/EMBEDDED_BROWSER.md).

## Development and checks

Use Node.js 22 or later, the repository's pinned Rust toolchain, and the
[platform prerequisites](../../docs/BUILD.md). Build shared libraries before the
frontend because workspace imports resolve to their generated `dist` directories.

```sh
npm install
make libs
npm run tauri:dev -w @smirk/desktop
```

The Vite development server uses port 1420. To check the shell without starting
it or signing an artifact:

```sh
npm run typecheck -w @smirk/desktop
npm test -w @smirk/desktop
node --test scripts/__tests__/*.test.mjs
```

The desktop regression suite bundles the swap transport and executes a quote
through simulated native IPC. This proves transport selection without spending
funds or contacting a swap provider. It does not replace a packaged-app quote
check on each operating system.

## Packaging and release evidence

```sh
npm run tauri:build -w @smirk/desktop
```

Tauri writes to `src-tauri/target/release/bundle`, or the corresponding target
triple directory when `--target` is supplied. The configured targets are macOS
`.app`, Linux AppImage and Debian packages, and Windows NSIS installers. CI wraps
the macOS app in a disk image and stages Windows portable executables separately.
A local development package is not proof that a release is signed or notarized.

The [release workflow](../../.gitea/workflows/desktop-build.yml) builds candidates
and uploads internal workflow artifacts named by source commit. It does not
replace public release assets. Each platform carries generated
`RELEASE-PROVENANCE-<platform>-v<version>.json` evidence tying its artifact digests
to the exact source commit and tree.

- macOS requires Developer ID signing, the expected Apple team, hardened runtime,
  a valid notarization staple, and Gatekeeper acceptance before staging.
- Windows uses the signing broker and verifies Authenticode, publisher, and
  timestamp on both installer and portable executable. Unsigned comparison
  artifacts stay separately named.
- Linux and the extension receive detached release signatures when the complete
  candidate set is assembled.

Use the [shared release candidate procedure](../../docs/BUILD.md#release-candidates-and-signatures)
to collect one successful run, verify its exact source provenance, and sign the
complete set. Reports and release decisions belong in `~/journal`.

## Updates and limitations

Users currently update by downloading and reinstalling the verified release.
The Tauri updater plugin, public key, endpoint, and payload-signing configuration
exist, but no client code invokes an update check or installation. These settings
alone do not establish automatic updates.

The desktop has no extension background worker, alarm service, or notification
service. Auto-lock uses a foreground timer and checks the original expiry when
the wallet reopens; reopening does not extend it. Background hints and native
notifications therefore have less coverage than the extension. There is no
system tray, autostart option, or `smirk://` deep-link handler.

Webview network policy accepts runtime-selected backends. The native HTTP
allowlist currently governs Trocador only. Do not describe that provider scope
as a general network restriction for the wallet.

## Release checklist

- [ ] All platform candidates identify the same reviewed source commit and tree.
- [ ] Packaged wallet unlock, send, and quote checks pass on each supported OS.
- [ ] macOS signature, notarization, staple, and Gatekeeper checks pass.
- [ ] Windows executable signatures, publisher, and timestamps pass.
- [ ] Artifact provenance, checksums, and detached signatures verify.
- [ ] Update and support copy states the behavior this release actually provides.
- [ ] Publication and store submission use their separately reviewed release lane.
