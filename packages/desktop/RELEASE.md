# Releasing the Smirk Wallet desktop app

Step-by-step for shipping a new desktop build. The workflow itself
lives at [.github/workflows/desktop-release.yml](../../.github/workflows/desktop-release.yml).

## Prerequisites (one-time setup)

### 1. Tauri updater keypair

The updater verifies that downloaded updates were signed by us, not
swapped at a CDN edge. Generate the keypair locally and keep the
private key offline.

```sh
cargo tauri signer generate -w ~/.tauri/smirk-updater.key
```

The command prints two files:
- `~/.tauri/smirk-updater.key` — **private key. Never commit. Never
  paste into a chat. Back this up offline.**
- `~/.tauri/smirk-updater.key.pub` — public key (paste below)

Open `packages/desktop/src-tauri/tauri.conf.json` and:
- Set `plugins.updater.active` to `true`
- Replace the `pubkey` placeholder with the contents of
  `smirk-updater.key.pub`

For each release, the workflow pulls the private key from secrets at
build time:
- GitHub repo settings → Secrets and variables → Actions → New secret:
  - `TAURI_SIGNING_PRIVATE_KEY` — the literal contents of
    `smirk-updater.key` (base64-encoded blob).
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the passphrase you set
    during `cargo tauri signer generate` (use one).

### 2. Apple signing + notarization

For macOS bundles to install cleanly on user machines without the
"unidentified developer" warning, the `.dmg` must be code-signed
with an Apple Developer ID Application certificate and notarized
through Apple's notary service.

Generate the certificate via Apple Developer Portal → Certificates →
Developer ID Application. Download the `.cer`, double-click into
Keychain Access, then export from Keychain as a `.p12` with a
passphrase.

Add as GitHub Actions secrets:
- `APPLE_CERTIFICATE` — base64-encoded `.p12` contents
  (`base64 -i cert.p12 | pbcopy`)
- `APPLE_CERTIFICATE_PASSWORD` — the passphrase you set
- `APPLE_SIGNING_IDENTITY` — e.g. `Developer ID Application: Such
  Software (TEAMID)`
- `APPLE_ID` — your Apple ID email
- `APPLE_PASSWORD` — an app-specific password generated at
  appleid.apple.com (NOT your Apple ID login password)
- `APPLE_TEAM_ID` — 10-character ID from Apple Developer portal

When all six are set, the workflow's macOS leg signs + notarizes
automatically. When they're missing or empty, the workflow still
produces an unsigned bundle (useful for test releases).

### 3. Windows + Linux signing — explicit non-goal for v0.3.0

Per the project's ship plan, v0.3.0 ships Windows and Linux unsigned.
Users will see SmartScreen / kernel warnings on first launch. The
release notes call this out and provide SHA256 checksums.

Code-signing on Windows requires an Authenticode cert from a CA
(~$300/yr for an EV cert that bypasses SmartScreen immediately). On
Linux, AppImage signing is uncommon — most users verify the SHA256
against the published value.

If we get user demand for signed Windows builds, the workflow is
ready to take the cert (uncomment the cert fields in the matrix and
add `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD` secrets).

## Cutting a release

1. **Update CHANGELOG.md** at the monorepo root with the new
   version's entry, following the existing format. Bump the link
   anchors at the bottom.
2. **Bump version** in three places (they must match exactly):
   - `packages/desktop/package.json` `version`
   - `packages/desktop/src-tauri/Cargo.toml` `version`
   - `packages/desktop/src-tauri/tauri.conf.json` `version`
3. **Commit** the version bump + CHANGELOG entry:
   ```sh
   git commit -am "release(desktop): v0.3.1"
   ```
4. **Tag** the commit. The tag name must match `v*`:
   ```sh
   git tag v0.3.1
   git push origin main v0.3.1
   ```
5. The `desktop-release` workflow fires automatically on the tag
   push. Watch the Actions tab — the matrix takes ~30-45 minutes for
   the full three-platform build.
6. **Verify** the published GitHub release has:
   - macOS: `Smirk Wallet_0.3.1_universal.dmg`
   - Windows: `Smirk Wallet_0.3.1_x64_en-US.msi`
   - Linux: `smirk-wallet_0.3.1_amd64.AppImage`
   - A `latest.json` file (the updater manifest, signed)
7. **Smoke-test** each platform's binary by installing on a clean
   VM. Lock + unlock the wallet, send a tiny transaction, claim a
   tip. Cross-check against the CHANGELOG.
8. **Announce** via the website + Telegram channel + relevant
   social channels.

## Test build (no publish)

To validate a workflow change before tagging, fire the workflow
manually:

1. Actions tab → "Desktop release" → "Run workflow"
2. Leave **Publish release** unchecked
3. The workflow runs on the current `main` HEAD, builds all three
   platforms, and uploads to a **draft** release. Download from the
   draft release page, test, delete the draft when done.

## Rollback

If a published release has a critical bug:
1. **Delete the GitHub release** (keeps the tag, removes the binaries).
2. **Bump the version + cut a new tag** with the fix.
3. The updater served the previous `latest.json` until the new
   release publishes — old installs auto-pull the fix on next
   update check. Users on the broken release have to manually
   download the new one if their wallet won't open.

If the updater itself is broken (signing key compromise, manifest
corruption): rotate the keypair, ship the new public key in the
NEXT release, then revoke the old private key from any storage. The
updater's signature verification means an attacker who steals the
old key can't impersonate us on the new pubkey.
