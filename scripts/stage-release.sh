#!/usr/bin/env bash
# Unpack downloaded CI artifacts into the layout the signing tools expect.
#
# Gitea wraps each workflow artifact in a zip; the desktop ones then contain a
# tar.gz of that platform's bundles, and the extension one contains the release
# zips plus SHA256SUMS and TOOLCHAIN. sign-release.sh and make-updater-manifest.sh
# both want a bundle dir laid out per-platform, so normalise it here rather than
# by hand at 2am.
#
# Usage:
#   scripts/stage-release.sh 0.3.0                       # from ~/Downloads
#   scripts/stage-release.sh 0.3.0 --from ~/Downloads --dest ~/release-v0.3.0
set -euo pipefail

fail() { echo "stage-release: $1" >&2; exit 1; }

VERSION="${1:-}"
[ -n "$VERSION" ] || fail "no version. Usage: $0 <version> [--from DIR] [--dest DIR]"
shift

SRC="$HOME/Downloads"
DEST="$HOME/release-v${VERSION}"
while [ $# -gt 0 ]; do
  case "$1" in
    --from) SRC="${2:-}"; shift 2 ;;
    --dest) DEST="${2:-}"; shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

command -v unzip >/dev/null 2>&1 || fail "unzip is not installed"
[ -d "$SRC" ] || fail "no such source directory: $SRC"

mkdir -p "$DEST"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

shopt -s nullglob
zips=("$SRC"/smirk-desktop-*-v"$VERSION"*.zip "$SRC"/smirk-extension-v"$VERSION"*.zip)
[ ${#zips[@]} -gt 0 ] || fail "no smirk artifact zips for v$VERSION found in $SRC"

echo "staging ${#zips[@]} artifact zip(s) into $DEST"

for z in "${zips[@]}"; do
  name="$(basename "$z")"
  echo "  $name"
  ex="$work/$(basename "$z" .zip)"
  mkdir -p "$ex"
  unzip -qo "$z" -d "$ex" || fail "could not unzip $name"

  # Desktop artifacts: a tar.gz per platform, named smirk-desktop-<os>-v<ver>.
  for t in "$ex"/smirk-desktop-*.tar.gz; do
    [ -e "$t" ] || continue
    platform="$(basename "$t" | sed -E 's/^smirk-desktop-(.+)-v.*$/\1/')"
    mkdir -p "$DEST/$platform"
    tar -xzf "$t" -C "$DEST/$platform"
    echo "    -> $platform/ ($(find "$DEST/$platform" -type f | wc -l | tr -d ' ') files)"
  done

  # Extension artifact: zips + checksums land at the top level, where
  # sign-release.sh looks for them.
  for f in "$ex"/*.zip "$ex"/SHA256SUMS-*.txt "$ex"/TOOLCHAIN-*.txt; do
    [ -e "$f" ] || continue
    cp -f "$f" "$DEST/"
    echo "    -> $(basename "$f")"
  done
done

# macOS tars carry AppleDouble sidecars that are not artifacts and must not be
# signed or checksummed; the runbook calls this out explicitly.
find "$DEST" -name '._*' -delete 2>/dev/null || true

echo
echo "staged in $DEST:"
find "$DEST" -maxdepth 2 -type f ! -name '*.asc' -printf '  %-58f %10s bytes\n' 2>/dev/null \
  || find "$DEST" -maxdepth 2 -type f ! -name '*.asc' -exec ls -la {} \; | awk '{printf "  %-58s %10s bytes\n", $9, $5}'

echo
echo "next, in this order (Authenticode rewrote the Windows exe, so any earlier"
echo "signature over it is stale):"
echo "  scripts/make-updater-manifest.sh $VERSION --bundle-dir $DEST"
echo "  SMIRK_SIGNING_KEY='<key id>' scripts/sign-release.sh $VERSION --bundle-dir $DEST"
