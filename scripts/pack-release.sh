#!/usr/bin/env bash
# pack-release.sh: build the three extension release archives REPRODUCIBLY, and
# record their checksums.
#
# Why this exists rather than a `zip -r` in RELEASE.md: zip stores each entry's
# mtime, and the mtimes in `dist/` come from whenever the build happened. Two
# builds of identical source therefore produce zips with different bytes and
# different checksums, which means a published SHA256SUMS describes exactly one
# copy of a file. Lose that copy and the record can never be satisfied again, by
# anyone, including us. That is not hypothetical: it is how the v0.3.0 zips
# became unreproducible when the working checkout disappeared.
#
# Two things make the output deterministic:
#   1. every entry's mtime is set to the HEAD commit's own timestamp, so the
#      archive is a function of the commit rather than of the clock;
#   2. entries are fed to zip in a stable, locale-independent sort order.
# `git archive` already does the same for the source zip, which is why that one
# was always reproducible.
#
# Usage:
#   scripts/pack-release.sh 0.3.0
#   scripts/pack-release.sh 0.3.0 --verify   # rebuild into a temp dir and
#                                            # compare against the recorded sums
set -euo pipefail

VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "usage: $0 <version> [--verify]" >&2; exit 2; }
VERIFY=0
[ "${2:-}" = "--verify" ] && VERIFY=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/packages/extension/releases"
DIST="$ROOT/packages/extension/dist"
mkdir -p "$OUT"

# The commit is the clock. `%ct` is committer date as a unix timestamp.
EPOCH="$(git log -1 --format=%ct)"
echo "packing v$VERSION at commit $(git rev-parse --short HEAD), mtime epoch $EPOCH"

# zip refuses to overwrite deterministically (it updates in place), so always
# start from nothing.
pack() {                    # pack <output.zip>
  local out="$1"
  rm -f "$out"
  ( cd "$DIST"
    # -h so a symlink's own mtime is set rather than its target's.
    find . -exec touch -h -d "@$EPOCH" {} +
    # -X drops uid/gid and platform extras; -o would set the archive mtime from
    # the newest entry, which is already normalised. Sorted, NUL-safe listing.
    find . -mindepth 1 -print | LC_ALL=C sort | zip -q -X -@ "$out"
  )
}

build_variant() {           # build_variant <chrome|firefox>
  local variant="$1"
  make "ext-$variant" >/dev/null
  pack "$OUT/smirk-wallet-$variant-v$VERSION.zip"
}

if [ "$VERIFY" -eq 1 ]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  echo "rebuilding into $tmp to compare against the recorded sums"
  build_variant chrome; cp "$OUT/smirk-wallet-chrome-v$VERSION.zip" "$tmp/"
  build_variant firefox; cp "$OUT/smirk-wallet-firefox-v$VERSION.zip" "$tmp/"
  git archive --format=zip --output="$tmp/smirk-wallet-source-v$VERSION.zip" HEAD
  ( cd "$tmp" && sha256sum -c <(grep -F -f <(ls) "$OUT/SHA256SUMS-v$VERSION.txt") )
  exit $?
fi

build_variant chrome
build_variant firefox
# Deterministic already: git archive derives mtimes from the commit.
git archive --format=zip --output="$OUT/smirk-wallet-source-v$VERSION.zip" HEAD

# The source archive is deliberately NOT in the committed sums file.
#
# git archive stamps every entry's mtime from the commit, so the archive's hash
# is a function of the commit. Recording that hash in a tracked file changes the
# commit, which changes the archive, which invalidates the hash just recorded.
# There is no fixed point: the value committed can never be the value a verifier
# computes at the tag. We shipped exactly that contradiction in v0.3.0, where the
# recorded source hash could not be reproduced from the tag it was recorded for.
#
# The extension zips have no such problem: they are built from source and do not
# contain this file, so their hashes are stable across the recording commit.
#
# The source archive's hash is still published, by sign-release.sh, into the
# SHA256SUMS that ships with the release and carries a PGP signature. That is the
# file a verifier should use anyway, since it is the signed one.
( cd "$OUT" && sha256sum \
    "smirk-wallet-chrome-v$VERSION.zip" \
    "smirk-wallet-firefox-v$VERSION.zip" > "SHA256SUMS-v$VERSION.txt" \
  && cat "SHA256SUMS-v$VERSION.txt" )

echo
echo "source archive (hash recorded at release time, not committed; see above):"
( cd "$OUT" && sha256sum "smirk-wallet-source-v$VERSION.zip" )

# Record the toolchain that produced these bytes.
#
# rustc is pinned by rust-toolchain.toml, and with it every file in the archives
# reproduces across machines EXCEPT the wasm: crates/secp256k1zkp/build.rs
# compiles C through cc-rs, so the C compiler version feeds the binary too.
# Measured 2026-08-19 at commit 02ea0ea: CI on clang 19 and a workstation on
# clang 21.1.8 produced identical JS, HTML, CSS and glue, and differed in
# smirk_wasm_bg.wasm alone.
#
# A repo file cannot pin clang the way it pins rustc, so record what was used
# instead of implying a guarantee we do not have. A reviewer who cannot match
# the wasm can at least see why, and match it deliberately if they choose.
{
  echo "# Toolchain that produced SHA256SUMS-v$VERSION.txt"
  echo "# commit: $(git rev-parse HEAD)"
  echo "rustc:         $(rustc --version 2>/dev/null || echo unknown)"
  echo "cargo:         $(cargo --version 2>/dev/null || echo unknown)"
  # The CLI is often only in ~/.cargo/bin, which a non-login shell misses.
  # Record the lockfile requirement too: that is the version that must match.
  echo "wasm-bindgen:  $(wasm-bindgen --version 2>/dev/null \
                        || "$HOME/.cargo/bin/wasm-bindgen" --version 2>/dev/null \
                        || echo "cli not on PATH")"
  echo "wasm-bindgen (Cargo.lock): $(cargo pkgid wasm-bindgen 2>/dev/null | sed 's/.*@//' || echo unknown)"
  echo "cc (C -> wasm): $(${CC:-clang} --version 2>/dev/null | head -1 || echo unknown)"
  echo "node:          $(node --version 2>/dev/null || echo unknown)"
  echo "npm:           $(npm --version 2>/dev/null || echo unknown)"
  echo "host:          $(uname -sm)"
} > "$OUT/TOOLCHAIN-v$VERSION.txt"
echo
cat "$OUT/TOOLCHAIN-v$VERSION.txt"

echo
echo "note: the firefox build runs last and leaves dist/ holding the FIREFOX"
echo "manifest. Anything reading dist/ after this sees Firefox, not Chrome."
