# Extension release process

How the Smirk Wallet browser extension is built, packaged, and shipped
to the Chrome Web Store + addons.mozilla.org. Read this end-to-end
before cutting a release: every step affects what users see.

## Versioning

Never hand-edit a version. `node scripts/bump-version.mjs <semver>`
writes every shipped artifact in one pass and aborts if any target is
missing, unparseable, or carries a malformed version, which is what
keeps these three from drifting apart (they must match exactly or the
build refuses to load in one of the stores):

- `packages/extension/package.json` `version`
- `packages/extension/manifest.json` `version`
- `packages/extension/manifest.firefox.json` `version`

`--check` verifies without writing (exit 1 if anything would change) and
`--print` lists what every target is at right now.

Tag the release commit `v0.X.Y` (no leading `v` prefix in
`manifest.json` itself).

## Build environment

Reproducibility on this extension is strong, with one honest edge. Verified
for v0.3.0 with a from-scratch build of the source zip in a different
directory: the shared JS libraries, HTML, CSS, the compiled `wasm`, and the
background/content/inject bundles are all byte-identical. The `wasm` is
byte-identical given the same rustc because `make wasm` passes
`--remap-path-prefix`, so the build directory and cargo home no longer leak
into the binary (that leakage previously made the wasm differ per build
location); a different rustc yields functionally-equivalent but not
byte-identical wasm. **The rustc version is pinned in `rust-toolchain.toml` at
the repo root, and rustup honours it automatically**, so a reviewer who builds
from a clean checkout gets the right compiler without being told a version
number. Before that file existed the guarantee was unusable: nothing pinned
rustc and CI tracked `stable`, so the same commit built on two machines
produced different wasm. The one exception is `popup.js`, the largest
entry bundle: Rollup names and orders its modules by absolute path, so a
build at a different directory produces a functionally-identical but not
byte-identical `popup.js` (deterministic for a given path). The zip
archive's own bytes vary with file mtimes, so reviewers reproduce by
comparing the built `dist` against the uploaded package's contents (see the
AMO note below), not by matching zip checksums. The published `SHA256SUMS`
identify the exact uploaded artifacts. Inputs:

- **Node:** `>=20.0.0` (matches the workspace `engines` field)
- **npm:** ships with the matched Node release
- **Rust:** pinned by `rust-toolchain.toml` at the repo root; rustup installs
  and selects it on its own, so do not override it with `+stable` or a
  `rustup default`. `make wasm` remaps build paths, so a clean checkout on the
  pinned rustc reproduces the wasm byte-for-byte wherever it is built. Bumping
  the pin changes the bytes of every shipped artifact and is a release
  decision: rebuild and re-record `SHA256SUMS` when it moves. (Note:
  `crates/monero-oxide` carries its own `rust-toolchain.toml` from the upstream
  fork. Its crates are members of this workspace, so builds driven from the
  repo root use the root pin; the nested file only binds someone running cargo
  from inside that directory.)
- **OS:** Linux x86_64 (the original build matrix). macOS arm64
  reproduces today; Windows hasn't been re-checked since v0.2.x
- **C compiler:** the wasm is not a pure-Rust artifact.
  `crates/secp256k1zkp/build.rs` compiles C through cc-rs, so the clang version
  feeds `smirk_wasm_bg.wasm` alongside rustc. Measured 2026-08-19: with rustc
  and wasm-bindgen matched, CI on clang 19 and a workstation on clang 21.1.8
  produced byte-identical JS, HTML, CSS and glue, and differed in the wasm
  alone. A repo file cannot pin clang the way `rust-toolchain.toml` pins rustc,
  so each release records what it used in `TOOLCHAIN-v<version>.txt` next to
  `SHA256SUMS`. Match that to match the wasm.
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
# 0. Sanity: make sure everything passes
make wasm
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present

# Set this once. Every step below reads it, so a release cannot end up with the
# tag saying one version and a zip filename saying another.
VERSION=0.3.0

# 1. Bump every shipped version in lockstep, both manifests included, + commit
node scripts/bump-version.mjs "$VERSION"
node scripts/bump-version.mjs "$VERSION" --check   # refuses to pass if any file lagged

# 2. Build deps + chrome variant
#    There is NO release-only env flag. VITE_SMIRK_RELEASE used to arm a
#    tripwire that refused to boot a build still carrying the v0.2-era stub
#    wallet ops; the stubs are gone, so the tripwire could only ever break a
#    release build, and it was deleted in 4a31da5. Nothing reads the flag now,
#    so setting it changes nothing and leaving it unset guards nothing. What
#    actually protects the send path is step 0: run it, and do not ship on red.
mkdir -p packages/extension/releases
make ext-chrome
( cd packages/extension/dist && zip -r -X "../releases/smirk-wallet-chrome-v$VERSION.zip" . )

# 3. Build firefox variant (overwrites dist/)
make ext-firefox
( cd packages/extension/dist && zip -r -X "../releases/smirk-wallet-firefox-v$VERSION.zip" . )

# 4. Source archive for AMO (deterministic: tied to git HEAD)
git archive --format=zip --output="packages/extension/releases/smirk-wallet-source-v$VERSION.zip" HEAD

# 5. Checksums: publish these in the GitHub release notes
( cd packages/extension/releases &&
  sha256sum "smirk-wallet-chrome-v$VERSION.zip" \
            "smirk-wallet-firefox-v$VERSION.zip" \
            "smirk-wallet-source-v$VERSION.zip" \
    > "SHA256SUMS-v$VERSION.txt" )

# 6. Commit the checksum file: it is the in-repo release record. Only a text
#    file under releases/ changes, so the tagged tree still builds the shipped
#    bytes.
git add "packages/extension/releases/SHA256SUMS-v$VERSION.txt"
git commit -m "chore: record v$VERSION extension checksums"

# 7. Tag + push: tag the EXACT commit the uploaded zips were built from
git tag "v$VERSION"
git push origin main "v$VERSION"
```

> **Tag at the built commit, and re-tag if you re-ship.** A reviewer
> reproduces by rebuilding the tagged source and content-matching the
> upload, so the tag must point at the commit the shipped zips were built
> from. If you regenerate the store zips after tagging (a late fix, a
> rebuild), move the tag to the commit you actually built and uploaded.
> Watch for this: the shipped v0.3.0 store zips were regenerated several
> times (auto-link, then the dapp decimal-amount fix) after the original
> `v0.3.0` tag was placed, so the tag ended up well behind the artifacts
> that actually shipped. Treat that as the anti-pattern.

## Signatures

Every shipped artifact carries a detached OpenPGP signature, and so does
`SHA256SUMS-v<version>.txt`. The signed checksum file is the one that matters for
anyone who installed from a store or a mirror: they have no `.asc` beside the
file, but they can still check the download against a list you signed.

Signing key, also committed as `KEYS.asc` at the repo root:

```
Smirk Releases <jw@such.software>
primary  5C5C255C 6B1BF28C 7C55C186 3401D818 39135A6F   ed25519, expires 2028-08-13
signing  79153CE3 AA4D0361 0F0EE105 96F6836D 5110C2CB   ed25519, expires 2028-08-13
```

Sign with the SUBKEY. The trailing `!` pins gpg to it, so the primary never has
to leave the machine that holds it:

```sh
SMIRK_SIGNING_KEY=96F6836D5110C2CB! scripts/sign-release.sh "$VERSION" \
  --bundle-dir ~/smirk-desktop-v$VERSION
```

Verify without signing: `scripts/sign-release.sh "$VERSION" --verify`.

A verifier should fetch `KEYS.asc` from somewhere OTHER than the host serving the
download. If the key and the artifact come from the same place, an attacker who
controls that place serves a matching pair and the signature proves nothing.

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
shipping: drift usually means a stray `Date.now()`, hostname leak,
or an unpinned dependency.

## Chrome Web Store upload

1. Sign in to the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole).
2. Open the existing Smirk Wallet listing.
3. **Package** → **Upload new package** → choose
   `smirk-wallet-chrome-v0.3.0.zip`.
4. Update **Store listing** copy if any user-facing changes warrant it.
5. **Privacy practices**: answer from `store/LISTING.md` "Data
   disclosures", which is the source of truth and cites the call behind
   every answer. There is no remote code, and the seed, the private
   spend keys and the Nostr secret key never leave the device, but this
   is NOT a zero-transmission extension: a light wallet sends the user's
   own receive address plus the Monero/Wownero view key and the Grin
   `rewind_hash` to the backend, which is how it gets a balance without
   downloading the chain. So the financial, authentication, PII and
   personal-communications boxes are all ticked, and the three
   certifications (not sold, not repurposed, not used for
   creditworthiness) are all signed. Declaring "collects nothing" here
   is a false declaration, and it contradicts the manifest.
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
   below: reviewers re-run it to confirm the upload zip matches the
   source. It is the short form of the `README.md` in `store/LISTING.md`
   ("AMO: source code submission"), which is the source of truth for
   these steps; if one changes, change both.

   ```
   Reproducible build instructions (Linux/macOS, Node 22.x, GNU make):

   # Prerequisites. The extension embeds a WebAssembly bundle compiled from the
   # Rust sources in crates/, so the build needs a Rust toolchain. The exact
   # rustc is pinned in rust-toolchain.toml at the root of the source archive,
   # and rustup reads that file automatically: run cargo from the archive root
   # and the right compiler is selected and installed for you. Do NOT pass
   # +stable or set a rustup default, which is how you end up with
   # functionally-equivalent but not byte-identical wasm.
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   # The wasm-bindgen CLI must match the version in Cargo.lock (0.2.121 for
   # v0.3.0); a version mismatch fails the build.
   cargo install wasm-bindgen-cli --version 0.2.121

   unzip smirk-wallet-source-v0.3.0.zip -d smirk
   cd smirk
   # ci, not install: the committed package-lock.json is the only source of
   # dep versions.
   npm ci
   # Builds wasm + every workspace lib in derived topological order
   # (scripts/build-workspaces.mjs) + the firefox extension. No hand-maintained
   # build list to fall out of sync. The wasm step is not optional:
   # crates/smirk-wasm/pkg/ is gitignored and therefore absent from this
   # archive, and vite fails with "WASM bundle missing" without it.
   make ext-firefox
   # Note: Cargo.lock references two git sources (jwinterm/grin-wallet and
   # mimblewimble/grin). These are DEV-ONLY cross-validation test deps of the
   # grin-ext crate; they are NOT compiled by the extension build. `make wasm`
   # runs `cargo build -p smirk-wasm`, which resolves from crates.io plus the
   # sibling path crates under crates/ that ship in this archive, so the build
   # does not fetch them.
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
CHANGELOG.md, which is the source of truth):

- Switchable Nostr identities: hold several identities and choose which
  one a site, Feed post, or message uses, with "Sign in with Nostr" on
  sites that support it. Messaging moved into the Inbox tab.
- Publish a NIP-05 handle (`name@domain`) when you claim a Smirk handle;
  back up and restore your Nostr identities as an encrypted blob.
- Grin is fully non-custodial and recoverable from your seed phrase alone.
- Self-hostable, federated backend: point the wallet at any Smirk backend
  and pay by NIP-05 address.
- Dapp payments quote plain decimal amounts; a `9` WOW request no longer
  crashes the approval.
- New onboarding: on import, the wallet detects an existing Smirk
  handle and any linked Telegram/Discord identities and surfaces them
  instead of prompting to reserve a new handle.
- Inline SVG eye toggle replaces emoji icons that didn't render on
  some Linux + Windows configs.
- "Import wallet" vs "Create wallet" button now reads correctly on
  the password screen depending on flow.
- Permission cleanup: `scripting` and `activeTab` removed from the
  manifest (they were never used).
- AMO listing now declares what the wallet actually transmits on the
  Firefox data-collection-permissions screen
  (`financialAndPaymentInfo`, `authenticationInfo`,
  `personallyIdentifyingInfo`, `personalCommunications`) instead of
  `"none"`, matching the Chrome disclosures in `store/LISTING.md`.

## Rollback

If a release ships and surfaces a regression:

- Chrome Web Store doesn't support arbitrary rollback. Cut a hotfix
  release with the previous code + a bumped patch version.
- AMO supports disabling the current version; previous version
  remains active for users who already have it installed.

Either way, the in-wallet "auto-update detected, reload" hint never
runs without a real upload, so users don't get downgraded silently.

## Artifact retention

Release zips are **build artifacts and are not committed** to the repo:
`packages/extension/releases/*.zip` is git-ignored, so a fresh clone carries
`releases/SHA256SUMS-vX.Y.Z.txt` and no zips. Never assume the zips are
present in the tree.

The audit trail is the **`SHA256SUMS` file**, committed under `releases/` and
published in the GitHub release notes. Anyone rebuilds from the tagged source
and content-compares against the checksummed upload (see "Verify
reproducibility" above); the checksums pin exactly what was shipped at each
tagged version. Keep old `SHA256SUMS-vX.Y.Z.txt` in the tree and in the
release notes indefinitely.
