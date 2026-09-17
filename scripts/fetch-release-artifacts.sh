#!/usr/bin/env bash
# Stage a release's CI artifacts from Gitea into a signing directory.
#
# Collection used to have no scriptable path. Gitea's Actions artifacts API
# reports `total_count 0` on our instance even for runs that plainly uploaded
# (confirmed on completed runs 6394 and 6086), which left a browser download or
# an interactive shell on the Gitea host as the only options. The releases API on
# the same host, with the same token, works, so desktop-build.yml attaches each
# leg's archive to a release keyed on the tag and this fetches them back.
#
# Usage:
#   scripts/fetch-release-artifacts.sh 0.3.0
#   scripts/fetch-release-artifacts.sh 0.3.0 --dest ~/release-v0.3.0
#
# Reads the API token from ~/.config/gitea-token. The value never appears in
# argv: it goes into the process through a header file curl reads itself, so it
# cannot be seen in `ps` output by other users on the host.
set -euo pipefail

fail() {
  # A refusal says why. Under `set -e` a bare exit leaves an operator with an
  # empty terminal and nothing to act on.
  echo "fetch-release-artifacts: $1" >&2
  exit 1
}

VERSION="${1:-}"
[ -n "$VERSION" ] || fail "no version given. Usage: $0 <version> [--dest DIR]"
shift

DEST="$HOME/release-v${VERSION}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:-}"; [ -n "$DEST" ] || fail "--dest needs a directory"; shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

TOKEN_FILE="$HOME/.config/gitea-token"
[ -r "$TOKEN_FILE" ] || fail "no readable token at $TOKEN_FILE"

REPO="${SMIRK_BUILDS_REPO:-Builds/smirk-monorepo}"
HOST="${SMIRK_GITEA_HOST:-https://git.such.software}"
API="$HOST/api/v1/repos/$REPO"
TAG="v$VERSION"

# Token via a header file rather than -H on the command line, so it stays out of
# argv. Deleted on exit including on failure.
HDR="$(mktemp)"
trap 'rm -f "$HDR"' EXIT
printf 'Authorization: token %s\n' "$(cat "$TOKEN_FILE")" > "$HDR"
chmod 600 "$HDR"

REL="$(mktemp)"
code=$(curl -sk -o "$REL" -w '%{http_code}' -H "@$HDR" "$API/releases/tags/$TAG" || true)
if [ "$code" != "200" ]; then
  fail "no release for $TAG on $REPO (HTTP $code). The build legs publish it; check they finished."
fi

mkdir -p "$DEST"

# Names and download URLs, one per line. Parsed in python rather than sed so a
# name containing a space (the Tauri bundles do) survives.
mapfile -t ROWS < <(python3 - "$REL" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for a in (d.get("assets") or []):
    print("%s\t%s" % (a.get("name"), a.get("browser_download_url")))
PY
)
rm -f "$REL"

[ "${#ROWS[@]}" -gt 0 ] || fail "release $TAG exists but carries no assets yet"

echo "staging ${#ROWS[@]} assets from $TAG into $DEST"
for row in "${ROWS[@]}"; do
  name="${row%%$'\t'*}"
  url="${row#*$'\t'}"
  out="$DEST/$name"
  curl -sk --fail-with-body -L -H "@$HDR" -o "$out" "$url" \
    || fail "failed downloading $name"
  echo "  $name ($(wc -c < "$out") bytes)"
done

# The desktop legs ship tarballs; unpack them into per-platform directories so
# the layout matches what sign-release.sh --bundle-dir expects.
for tarball in "$DEST"/smirk-desktop-*.tar.gz; do
  [ -e "$tarball" ] || continue
  platform="$(basename "$tarball" | sed -E 's/^smirk-desktop-(.+)-v.*$/\1/')"
  mkdir -p "$DEST/$platform"
  tar -xzf "$tarball" -C "$DEST/$platform"
  echo "  unpacked $platform/"
done

echo
echo "staged in $DEST. Next, in order, because Authenticode rewrote the Windows"
echo "exe and that invalidates any earlier signature over it:"
echo "  scripts/make-updater-manifest.sh $VERSION --bundle-dir $DEST"
echo "  SMIRK_SIGNING_KEY='<key id>' scripts/sign-release.sh $VERSION --bundle-dir $DEST"
