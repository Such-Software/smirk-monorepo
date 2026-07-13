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

Reproducibility on this extension is strong, with one honest edge. Verified
for v0.3.0 with a from-scratch build of the source zip in a different
directory: the shared JS libraries, HTML, CSS, the compiled `wasm`, and the
background/content/inject bundles are all byte-identical. The `wasm` is
byte-identical given the same rustc (v0.3.0 shipped rustc 1.95.0) because
`make wasm` passes `--remap-path-prefix`, so the build directory and cargo
home no longer leak into the binary (that leakage previously made the wasm
differ per build location); a different rustc yields functionally-equivalent
but not byte-identical wasm. The one exception is `popup.js`, the largest
entry bundle: Rollup names and orders its modules by absolute path, so a
build at a different directory produces a functionally-identical but not
byte-identical `popup.js` (deterministic for a given path). The zip
archive's own bytes vary with file mtimes, so reviewers reproduce by
comparing the built `dist` against the uploaded package's contents (see the
AMO note below), not by matching zip checksums. The published `SHA256SUMS`
identify the exact uploaded artifacts. Inputs:

- **Node:** `>=20.0.0` (matches the workspace `engines` field)
- **npm:** ships with the matched Node release
- **Rust:** rustc 1.95.0 for v0.3.0. `make wasm` remaps build paths so a
  clean checkout on the same rustc reproduces the wasm byte-for-byte no
  matter where it is built
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
   npm install
   # Builds wasm + every workspace lib in derived topological order
   # (scripts/build-workspaces.mjs) + the firefox extension. No hand-maintained
   # build list to fall out of sync.
   make ext-firefox
   # Note: Cargo.lock references two git sources (jwinterm/grin-wallet and
   # mimblewimble/grin). These are DEV-ONLY cross-validation test deps of the
   # grin-ext crate; they are NOT compiled by the extension build. `make wasm`
   # builds `cargo -p smirk-wasm`, which resolves entirely from crates.io + the
   # vendored crates in this archive, so the build does not fetch them.
   # Compare the freshly-built dist against the uploaded package by CONTENT
   # (the zip's own bytes vary by file mtime, so verify files, not the archive):
   mkdir _uploaded && ( cd _uploaded && unzip -q ../smirk-wallet-firefox-v0.3.0.zip )
   diff -rq _uploaded packages/extension/dist
   # Expected: the ONLY file that may differ is popup.js. The compiled wasm, every
   # shared library, and the background/content/inject bundles are byte-identical.
   # popup.js (the largest entry bundle) is minified slightly differently when
   # built at a different absolute path, because Rollup names + orders modules by
   # their absolute path: the behaviour is identical, only variable names/ordering
   # change, and it is deterministic for a given build path.
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
