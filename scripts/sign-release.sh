#!/usr/bin/env bash
# sign-release.sh: detach-sign every shipped artifact for a release, and verify.
#
# Covers all five shipping targets in one pass, because a release that signs the
# extension but not the desktop bundles gives a user no way to tell which half
# they are supposed to trust:
#
#   extension : chrome zip, firefox zip, source zip  (packages/extension/releases)
#   desktop   : macOS .dmg / .app.tar.gz, Linux .AppImage / .deb, Windows .msi / .exe
#               (packages/desktop/src-tauri/target/release/bundle, or --bundle-dir)
#
# Each artifact gets a detached ASCII signature next to it (`<file>.asc`), and the
# SHA256SUMS file is signed too. Signing the sums file is the one that matters
# most: it is what lets someone verify a download they got from a store or a
# mirror, where the .asc may not travel with the file.
#
# Usage:
#   scripts/sign-release.sh 0.3.0                    # sign, then verify
#   scripts/sign-release.sh 0.3.0 --verify           # verify only, sign nothing
#   SMIRK_SIGNING_KEY=<keyid> scripts/sign-release.sh 0.3.0
#   scripts/sign-release.sh 0.3.0 --bundle-dir /path/to/downloaded/ci/bundles
#
# SMIRK_SIGNING_KEY should name the RELEASE SIGNING SUBKEY, not the primary. Give
# it the subkey with an exclamation mark (`ABCD1234!`) so gpg uses exactly that
# subkey rather than picking one itself. The primary never needs to be present on
# a build machine or in CI.
set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ] || [ "$VERSION" = "--help" ] || [ "$VERSION" = "-h" ]; then
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
shift || true

VERIFY_ONLY=0
BUNDLE_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --verify)     VERIFY_ONLY=1 ;;
    --bundle-dir) BUNDLE_DIR="${2:-}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT/packages/extension/releases"
BUNDLE_DIR="${BUNDLE_DIR:-$ROOT/packages/desktop/src-tauri/target/release/bundle}"
SUMS="$EXT_DIR/SHA256SUMS-v$VERSION.txt"

command -v gpg >/dev/null 2>&1 || { echo "gpg not found on this machine" >&2; exit 1; }

# `--local-user` only when the caller pinned a key: with no key set, gpg's default
# is correct on a machine that holds exactly one secret key, and being explicit
# about "no key selected" beats silently signing with an unexpected one.
KEYARGS=()
if [ -n "${SMIRK_SIGNING_KEY:-}" ]; then
  KEYARGS=(--local-user "$SMIRK_SIGNING_KEY")
fi

# Collect the artifacts that actually exist. A missing desktop bundle is normal
# (the desktop release is built by CI on a tag, not locally), so absence is
# reported rather than treated as failure. An absent EXTENSION zip is a real
# problem and is called out separately below.
artifacts=()
for f in \
  "$EXT_DIR/smirk-wallet-chrome-v$VERSION.zip" \
  "$EXT_DIR/smirk-wallet-firefox-v$VERSION.zip" \
  "$EXT_DIR/smirk-wallet-source-v$VERSION.zip"
do
  [ -f "$f" ] && artifacts+=("$f")
done
ext_count=${#artifacts[@]}

if [ -d "$BUNDLE_DIR" ]; then
  # Tauri lays bundles out per packager. Signing the installers users actually
  # download, plus the updater tarball, and deliberately NOT the `.sig` files
  # Tauri's own updater emits: those are updater signatures, a separate scheme.
  while IFS= read -r -d '' f; do artifacts+=("$f"); done < <(
    find "$BUNDLE_DIR" -type f \
      \( -name '*.dmg' -o -name '*.app.tar.gz' \
      -o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \
      -o -name '*.msi' -o -name '*.exe' \) -print0 2>/dev/null | sort -z
  )
fi
desktop_count=$(( ${#artifacts[@]} - ext_count ))

[ -f "$SUMS" ] && artifacts+=("$SUMS")

if [ ${#artifacts[@]} -eq 0 ]; then
  echo "nothing to sign: no v$VERSION artifacts under" >&2
  echo "  $EXT_DIR" >&2
  echo "  $BUNDLE_DIR" >&2
  exit 1
fi

echo "v$VERSION: $ext_count extension, $desktop_count desktop, $([ -f "$SUMS" ] && echo 1 || echo 0) checksum file"
[ "$ext_count" -lt 3 ] && echo "  WARNING: expected 3 extension artifacts, found $ext_count"
[ "$desktop_count" -eq 0 ] && echo "  note: no desktop bundles present (CI builds those on a tag)"

if [ "$VERIFY_ONLY" -eq 0 ]; then
  echo
  echo "signing:"
  for f in "${artifacts[@]}"; do
    # --yes so a re-run after a rebuild replaces the stale signature instead of
    # prompting; a signature for bytes that no longer exist is worse than none.
    gpg --batch --yes --armor --detach-sign "${KEYARGS[@]}" --output "$f.asc" "$f"
    echo "  $(basename "$f").asc"
  done
fi

echo
echo "verifying:"
rc=0
for f in "${artifacts[@]}"; do
  if [ ! -f "$f.asc" ]; then
    echo "  MISSING  $(basename "$f").asc"; rc=1; continue
  fi
  if out=$(gpg --batch --verify "$f.asc" "$f" 2>&1); then
    # Report the signing key so a wrong-key signature is visible rather than
    # just "Good signature", which is true of any key in the local keyring.
    who=$(printf '%s\n' "$out" | grep -oE 'using [A-Za-z0-9]+ key [A-F0-9]+' | head -1)
    echo "  OK       $(basename "$f")  ${who:-}"
  else
    echo "  BAD      $(basename "$f")"; printf '%s\n' "$out" | sed 's/^/             /'; rc=1
  fi
done

if [ -f "$SUMS" ]; then
  echo
  echo "checksums:"
  # macOS ships `shasum`, not GNU coreutils' `sha256sum`, and jw-macbook is Darwin.
  if command -v sha256sum >/dev/null 2>&1; then SUMCHECK=(sha256sum -c)
  else SUMCHECK=(shasum -a 256 -c); fi
  ( cd "$EXT_DIR" && "${SUMCHECK[@]}" "$(basename "$SUMS")" 2>&1 | sed 's/^/  /' ) || rc=1
fi

exit $rc
