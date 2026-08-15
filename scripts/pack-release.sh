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

( cd "$OUT" && sha256sum \
    "smirk-wallet-chrome-v$VERSION.zip" \
    "smirk-wallet-firefox-v$VERSION.zip" \
    "smirk-wallet-source-v$VERSION.zip" > "SHA256SUMS-v$VERSION.txt" \
  && cat "SHA256SUMS-v$VERSION.txt" )

echo
echo "note: the firefox build runs last and leaves dist/ holding the FIREFOX"
echo "manifest. Anything reading dist/ after this sees Firefox, not Chrome."
