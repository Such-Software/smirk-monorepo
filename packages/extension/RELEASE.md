# Extension release process

How the Smirk Wallet browser extension is built, packaged, and shipped
to the Chrome Web Store + addons.mozilla.org. Read this end-to-end
before cutting a release — every step affects what users see.

## Versioning

Bump these three places together. They must match exactly or the
build refuses to load in one of the stores:

- `packages/extension/package.json` `version`
- `packages/extension/manifest.json` `version`
- `packages/extension/manifest.firefox.json` `version`

Tag the release commit `v0.X.Y` (no leading `v` prefix in
`manifest.json` itself).

## Build environment

Reproducibility is a real promise on this extension — the same git
commit on the same Node/npm versions produces byte-identical zips
(verified during the v0.3.0 prep). Inputs:

- **Node:** `>=20.0.0` (matches the workspace `engines` field)
- **npm:** ships with the matched Node release
- **OS:** Linux x86_64 (the original build matrix). macOS arm64
  reproduces today; Windows hasn't been re-checked since v0.2.x
- **Lockfile:** the committed `package-lock.json` is the only source
  of dep versions; never run `npm update` mid-release
- **WASM bundle:** must be rebuilt before the extension. From the
  monorepo root: `make wasm`

The build also pulls workspace packages from their `dist/` outputs,
so all the upstream workspace packages must be built first. The
`make ext-chrome` / `make ext-firefox` targets do this in order.

## Cut a release

From a clean working tree (commit or stash everything first):

```sh
# 0. Sanity — make sure everything passes
make wasm
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present

# 1. Bump version in the three files listed above + commit

# 2. Build deps + chrome variant
make ext-chrome
( cd packages/extension/dist && zip -r -X ../releases/smirk-wallet-chrome-v0.3.0.zip . )

# 3. Build firefox variant (overwrites dist/)
make ext-firefox
( cd packages/extension/dist && zip -r -X ../releases/smirk-wallet-firefox-v0.3.0.zip . )

# 4. Source archive for AMO (deterministic — tied to git HEAD)
git archive --format=zip --output=packages/extension/releases/smirk-wallet-source-v0.3.0.zip HEAD

# 5. Checksums — publish these in the GitHub release notes
( cd packages/extension/releases &&
  sha256sum smirk-wallet-chrome-v0.3.0.zip \
            smirk-wallet-firefox-v0.3.0.zip \
            smirk-wallet-source-v0.3.0.zip \
    > SHA256SUMS-v0.3.0.txt )

# 6. Tag + push
git tag v0.3.0
git push origin main v0.3.0
```

## Verify reproducibility

Before upload, confirm a clean rebuild produces the same bytes:

```sh
# Snapshot the current build
cp -r packages/extension/dist /tmp/snap-1

# Clean rebuild
( cd packages/extension && npm run clean )
make ext-firefox    # or ext-chrome, whichever you snapshotted

# Diff
diff -r /tmp/snap-1 packages/extension/dist
```

Empty output = reproducible. If anything differs, investigate before
shipping — drift usually means a stray `Date.now()`, hostname leak,
or an unpinned dependency.

## Chrome Web Store upload

1. Sign in to the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole).
2. Open the existing Smirk Wallet listing.
3. **Package** → **Upload new package** → choose
   `smirk-wallet-chrome-v0.3.0.zip`.
4. Update **Store listing** copy if any user-facing changes warrant it.
5. **Privacy practices**: re-confirm the disclosures (no remote
   code, no PII collection — the extension is fully client-side
   except for backend tipping calls that the user explicitly opts
   into).
6. **Submit for review**. Typical turnaround: 1–3 business days for
   the first review on a new version with permission changes; a few
   hours for re-reviews with no permission changes.

## addons.mozilla.org (AMO) upload

AMO requires a source-code submission for any extension whose listing
JS isn't directly review-readable (i.e. any bundled / minified
extension). Our build *is* minified by Vite, so the source archive is
mandatory.

1. Sign in to the [AMO developer dashboard](https://addons.mozilla.org/en-US/developers/).
2. Open the existing Smirk Wallet listing (gecko id `wallet@smirk.cash`).
3. **New version** → upload `smirk-wallet-firefox-v0.3.0.zip`.
4. When prompted for source code, upload
   `smirk-wallet-source-v0.3.0.zip`.
5. In **Notes to reviewers**, paste the build instructions block
   below — reviewers re-run it to confirm the upload zip matches the
   source.

   ```
   Reproducible build instructions (Linux/macOS, Node 20+):

   unzip smirk-wallet-source-v0.3.0.zip -d smirk
   cd smirk
   make wasm
   npm install
   npm run build --workspace @smirk/wasm
   npm run build --workspace @smirk/assets
   npm run build --workspace @smirk/core
   npm run build --workspace @smirk/dapp-api
   npm run build --workspace @smirk/ui
   npm run build:firefox --workspace @smirk/extension
   ( cd packages/extension/dist && zip -r -X ../check.zip . )

   # The resulting check.zip should byte-match the uploaded
   # smirk-wallet-firefox-v0.3.0.zip. Confirmed SHA256:
   #   f30dc02100a5d9cc0877530eff51a5af42f7ae7e23e3c4a3cfd89f7f0e2236e6
   ```

6. **Submit**. AMO review for a new version typically lands within
   24h; new permission changes trigger a more thorough manual review.

## What changes in v0.3.0

User-facing recap for the store-listing notes (mirror the monorepo
CHANGELOG.md):

- New onboarding: on import, the wallet detects an existing Smirk
  handle and any linked Telegram/Discord identities and surfaces them
  instead of prompting to reserve a new handle.
- Inline SVG eye toggle replaces emoji icons that didn't render on
  some Linux + Windows configs.
- "Import wallet" vs "Create wallet" button now reads correctly on
  the password screen depending on flow.
- Permission cleanup — `scripting` and `activeTab` removed from the
  manifest (they were never used).
- AMO listing now correctly declares `"required": ["none"]` for the
  Firefox data-collection-permissions screen.

## Rollback

If a release ships and surfaces a regression:

- Chrome Web Store doesn't support arbitrary rollback. Cut a hotfix
  release with the previous code + a bumped patch version.
- AMO supports disabling the current version; previous version
  remains active for users who already have it installed.

Either way, the in-wallet "auto-update detected, reload" hint never
runs without a real upload, so users don't get downgraded silently.

## Artifact retention

The committed `releases/` directory ships every prior released zip
plus its SHA256. Don't prune historical zips — they're the audit
trail users / auditors / Mozilla reviewers can cross-check against
to confirm what was shipped at each tagged version.
