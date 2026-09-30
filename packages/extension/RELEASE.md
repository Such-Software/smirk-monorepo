# Extension release process

> Status: stable · Updated 2026-09-27 · Applies to: Chrome and Firefox release candidates

Use [BUILD.md](../../docs/BUILD.md) for the shared candidate, provenance and
signing procedure. This document owns extension packaging, reproduction and
store submission. [store/LISTING.md](store/LISTING.md) owns store copy and data
disclosures. Private custody details and submission receipts belong in the
journal's Smirk release runbook.

## Source and version

Begin from a clean, reviewed source commit with its required checks green.
Record the full source SHA. Build all release artifacts from that same commit;
do not substitute an old zip from a local release directory.

Use `node scripts/bump-version.mjs <version>` for version changes and its
`--check` mode to verify them. This updates the declared version sources and
projections together. Commit and review the change before building. Do not
commit new checksum records after building and then tag that different commit.
Do not move an existing public tag to repair mismatched artifacts. An existing
store version may require a new version number; verify the store's actual state
before submission.

## Build and package

The exact candidate workflow is [.gitea/workflows/desktop-build.yml](../../.gitea/workflows/desktop-build.yml).
It also produces the Chrome zip, Firefox zip and source archive. A candidate is
not a published release. Follow its exact-source collection and signing checks
in [BUILD.md](../../docs/BUILD.md).

For a local reproduction, install Node 22 or newer and the toolchain recorded by
the candidate. `rust-toolchain.toml` pins Rust; the wasm-bindgen CLI must match
`Cargo.lock`. Match clang as well because the WASM bundle includes C code.
Run from the source archive root:

```sh
npm ci
make ext-firefox
```

For Chrome, use `make ext-chrome`. Both targets rebuild WASM, build workspace
libraries in dependency order and bundle the extension. They share
`packages/extension/dist`, so package each variant before building the next.
The submitted source archive must come from the same immutable source commit.
Build-time public configuration must match the candidate; credential values do
not belong in the source archive or reviewer notes.

## Verify before signing

Run the unit, type and API checks in [TESTING.md](../../docs/TESTING.md), then
record the release integration evidence. Check extension installation, restored
unlock sessions, coin-detail Send, amount/review estimates, password confirmation
settings and the relevant dapp approvals on the final built package.

Rebuild from the submitted source archive in a clean directory and compare its
files with the submitted zip contents. Zip timestamps can differ. Any differing
bundle must be explained and verified; do not assume every `popup.js` difference
is harmless minification. Record toolchain versions, configuration names, source
SHA, file hashes and the comparison result. A successful build is not proof of
reproducibility.

Every shipped artifact and its checksum manifest receive detached OpenPGP
signatures under the release key identified by `KEYS.asc`. The signing helper
requires the expected source commit and verifies the candidate manifests first.
See [BUILD.md](../../docs/BUILD.md) for its current invocation. Verify signatures
with an independently obtained release public key.

## Submit to stores

Use the existing listing in the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole)
and [AMO developer dashboard](https://addons.mozilla.org/en-US/developers/).
Upload the corresponding verified zip. AMO also needs the matching source
archive and exact build instructions because the extension bundles JavaScript
and WASM.

Review the manifest permissions and disclosures against the final code. This is
a light wallet: its backend receives public addresses, Monero/Wownero private
view keys, Grin view credentials and signed transaction bytes. BTC/LTC outputs
reveal destinations and amounts. Nostr messages are encrypted; Feed posts and
published identity handles are public. Never declare that no data leaves the
extension.

Use [LISTING.md](store/LISTING.md) for text and screenshots. Check that the public
privacy page reflects the release before submission. Save submission identifiers,
review status and any reviewer requests in the private journal. Submission,
approval, publication and verified availability are different states.

## Release checklist

- [ ] Source SHA, tag, versions and all artifact provenance agree.
- [ ] Required source checks and release integration checks passed.
- [ ] Both browser variants install and have the correct manifests.
- [ ] The submitted source rebuild was compared with the submitted package.
- [ ] Signatures and checksums verify for every submitted artifact.
- [ ] Store copy, permissions, screenshots and privacy disclosures match code.
- [ ] Actual store submission and publication states are recorded privately.
- [ ] Public downloads are verified after publication.
