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
#   scripts/sign-release.sh 0.3.0 --bundle-dir DIR --expect-commit FULL_SHA
#   scripts/sign-release.sh 0.3.0 --bundle-dir DIR --expect-commit FULL_SHA --verify
#
# SMIRK_SIGNING_KEY must contain the full release signing subkey fingerprint,
# optionally followed by !. Signing pins that exact subkey; verification requires
# GPG's machine-readable VALIDSIG to name the same fingerprint. A default key,
# short key ID, or a human-readable "Good signature" is insufficient.
set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ] || [ "$VERSION" = "--help" ] || [ "$VERSION" = "-h" ]; then
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
shift || true

VERIFY_ONLY=0
BUNDLE_DIR=""
EXPECTED_COMMIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --verify)     VERIFY_ONLY=1 ;;
    --bundle-dir) BUNDLE_DIR="${2:-}"; shift ;;
    --expect-commit) EXPECTED_COMMIT="${2:-}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

EXPECTED_SIGNER="${SMIRK_SIGNING_KEY:-}"
EXPECTED_SIGNER="${EXPECTED_SIGNER%!}"
[[ "$EXPECTED_SIGNER" =~ ^[A-Fa-f0-9]{40}$ ]] || {
  echo 'sign-release: SMIRK_SIGNING_KEY must be the full release signing subkey fingerprint' >&2; exit 1;
}
EXPECTED_SIGNER="$(printf '%s' "$EXPECTED_SIGNER" | tr '[:lower:]' '[:upper:]')"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -n "$BUNDLE_DIR" ] && [ -d "$BUNDLE_DIR" ] || {
  echo 'sign-release: --bundle-dir must contain the complete staged CI release' >&2; exit 1;
}
[ -n "$EXPECTED_COMMIT" ] || {
  echo 'sign-release: --expect-commit is required to distinguish builds of the same version' >&2; exit 1;
}
# Validate all inputs before touching signatures or replacing the checksum list.
# Never fill gaps from a different checkout or a previous release directory.
node "$ROOT/scripts/release-artifacts.mjs" verify --dir "$BUNDLE_DIR" \
  --version "$VERSION" --expect-commit "$EXPECTED_COMMIT"
EXT_DIR="$BUNDLE_DIR"
SUMS="$EXT_DIR/SHA256SUMS-v$VERSION.txt"
if [ "$VERIFY_ONLY" -eq 1 ] && [ ! -f "$SUMS" ]; then
  echo 'sign-release: the staged release has no SHA256SUMS file to verify' >&2; exit 1;
fi
# The toolchain record is signed alongside the sums, so the release directory
# verifies on its own. It states which rustc, wasm-bindgen and C compiler
# produced these bytes, which is exactly what a reviewer needs when the wasm
# does not reproduce: the C compiler feeds it via cc-rs and cannot be pinned by
# rust-toolchain.toml. An unsigned provenance record is a provenance record
# anyone can rewrite.
TOOLCHAIN="$EXT_DIR/TOOLCHAIN-v$VERSION.txt"

command -v gpg >/dev/null 2>&1 || { echo "gpg not found on this machine" >&2; exit 1; }

KEYARGS=(--local-user "${EXPECTED_SIGNER}!")

# The provenance gate above requires every shipping platform.
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
  # `latest.json` is signed too. It is not a binary, but it is the file that
  # tells every installed client which binary to fetch, so it is worth as
  # much to an attacker as any bundle here. The minisign signatures inside
  # it stop a tampered manifest from installing anything, because the client
  # verifies the download against the key baked into the app; the detached
  # PGP signature is what lets a person verify the manifest itself.
  # download, plus the updater tarball, and deliberately NOT the `.sig` files
  # Tauri's own updater emits: those are updater signatures, a separate scheme.
  # `! -name ._*` drops AppleDouble sidecars: a macOS bundle tarred on a Mac and
  # untarred elsewhere leaves a `._Foo.dmg` next to `Foo.dmg`, and it matches the
  # same glob. Signing one would publish a signature for a metadata stub that no
  # user ever downloads.
  while IFS= read -r -d '' f; do artifacts+=("$f"); done < <(
    find "$BUNDLE_DIR" -type f ! -name '._*' \
      \( -name '*.dmg' -o -name '*.app.tar.gz' \
      -o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \
      -o -name '*.msi' -o -name '*.exe' -o -name 'latest.json' \) -print0 2>/dev/null | sort -z
  )
fi
desktop_count=$(( ${#artifacts[@]} - ext_count ))

# Sign the source-bound CI evidence alongside its artifacts.
while IFS= read -r -d '' f; do artifacts+=("$f"); done < <(
  find "$BUNDLE_DIR" -type f -name "RELEASE-PROVENANCE-*-v$VERSION.json" -print0 | sort -z
)
artifacts+=("$TOOLCHAIN")

# macOS has no `sha256sum`; it ships `shasum`. Same split the verify step makes.
if command -v sha256sum >/dev/null 2>&1; then SUMGEN=(sha256sum)
else SUMGEN=(shasum -a 256); fi

# Widen SHA256SUMS to cover EVERY artifact being signed, before it is signed.
#
# pack-release.sh writes it with the two extension zips alone, because the job
# that builds those never sees the desktop bundles, and its comment already
# promises this script publishes the rest. It did not: the file shipped
# describing 2 of 14 artifacts, so anyone reaching for the signed checksums to
# verify a .dmg or an .AppImage found nothing, and a per-file .asc does not help
# when a store or mirror strips the sidecar.
#
# Rebuilt rather than appended so re-running is idempotent, and written with
# paths relative to the bundle root so `shasum -c` works from where the release
# actually lives. Signatures and updater .sig files are excluded: they are not
# artifacts, and a checksum over a signature proves nothing about the thing it
# signs.
if [ "$VERIFY_ONLY" -eq 0 ] && [ ${#artifacts[@]} -gt 0 ]; then
  sums_tmp="$(mktemp)"
  for f in "${artifacts[@]}"; do
    case "$f" in *.asc|*.sig) continue ;; esac
    [ "$f" = "$SUMS" ] && continue
    # Record the PUBLISHED name, not the staging path. Assets are uploaded flat,
    # so a verifier downloads them into one directory and runs `shasum -c` there;
    # a `linux/` or `macos/` prefix from our bundle layout would make every
    # desktop line fail with "no such file" on their machine.
    base="$(basename "$f")"
    ( cd "$(dirname "$f")" && "${SUMGEN[@]}" "$base" ) >> "$sums_tmp"
  done
  # Flattening is only safe while basenames are unique; a collision would put two
  # different files under one name and silently verify the wrong one.
  dupes="$(cut -c67- "$sums_tmp" | LC_ALL=C sort | uniq -d)"
  if [ -n "$dupes" ]; then
    echo "refusing to write SHA256SUMS: duplicate asset names" >&2
    echo "$dupes" | sed 's/^/  /' >&2
    rm -f "$sums_tmp"
    exit 1
  fi
  if [ -s "$sums_tmp" ]; then
    LC_ALL=C sort -k2 "$sums_tmp" > "$SUMS"
    echo "SHA256SUMS covers $(wc -l < "$SUMS" | tr -d ' ') artifact(s)"
  fi
  rm -f "$sums_tmp"
fi

[ -f "$SUMS" ] && artifacts+=("$SUMS")

if [ ${#artifacts[@]} -eq 0 ]; then
  echo "nothing to sign: no v$VERSION artifacts under" >&2
  echo "  $EXT_DIR" >&2
  echo "  $BUNDLE_DIR" >&2
  exit 1
fi

echo "v$VERSION: $ext_count extension, $desktop_count desktop, $([ -f "$SUMS" ] && echo 1 || echo 0) checksum file, $([ -f "$TOOLCHAIN" ] && echo 1 || echo 0) toolchain record"

if [ "$VERIFY_ONLY" -eq 0 ]; then
  echo
  echo "signing:"
  for f in "${artifacts[@]}"; do
    # --yes so a re-run after a rebuild replaces the stale signature instead of
    # prompting; a signature for bytes that no longer exist is worse than none.
    gpg --batch --yes --armor --detach-sign ${KEYARGS[@]+"${KEYARGS[@]}"} --output "$f.asc" "$f"
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
  # Parse only the status channel. A UID or diagnostic can contain misleading
  # text, so stderr must never become signer evidence.
  if status=$(gpg --batch --status-fd 1 --verify "$f.asc" "$f" 2>/dev/null); then
    signer=$(printf '%s\n' "$status" | awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" { print toupper($3) }')
    invalid=$(printf '%s\n' "$status" | awk '$1 == "[GNUPG:]" && $2 ~ /^(BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|KEYEXPIRED|SIGEXPIRED|KEYREVOKED)$/ { print $2 }')
    if [ "$signer" = "$EXPECTED_SIGNER" ] && [ -z "$invalid" ]; then
      echo "  OK       $(basename "$f")  signer $signer"
    else
      if [ -n "$invalid" ]; then
        printf '  BAD      %s: GPG rejected signature validity: %s\n' "$(basename "$f")" "$invalid" >&2
      elif [ -z "$signer" ]; then
        echo "  BAD      $(basename "$f"): GPG supplied no VALIDSIG fingerprint" >&2
      elif [[ "$signer" == *$'\n'* ]]; then
        echo "  BAD      $(basename "$f"): GPG supplied multiple VALIDSIG fingerprints" >&2
      elif [[ "$signer" =~ ^[A-F0-9]{40}$ ]]; then
        echo "  BAD      $(basename "$f"): signer $signer differs from expected $EXPECTED_SIGNER" >&2
      else
        echo "  BAD      $(basename "$f"): GPG supplied a malformed VALIDSIG fingerprint" >&2
      fi
      rc=1
    fi
  else
    gpg_rc=$?
    reason=$(printf '%s\n' "$status" | awk '$1 == "[GNUPG:]" && $2 ~ /^(BADSIG|ERRSIG|NO_PUBKEY|NODATA|FAILURE|ERROR)$/ { print $2 }')
    echo "  BAD      $(basename "$f"): GPG verification failed (exit $gpg_rc)${reason:+: $reason}" >&2
    rc=1
  fi
done

if [ -f "$SUMS" ]; then
  echo
  echo "checksums:"
  # Published names are flat, but the staged artifacts live in platform
  # subdirectories. Verify those actual files without copying or flattening.
  node --input-type=module - "$SUMS" "${artifacts[@]}" <<'JS' || rc=1
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
const [sums, ...paths] = process.argv.slice(2);
const expected = new Map(readFileSync(sums, 'utf8').trim().split('\n').map((line) => {
  const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
  if (!match) throw new Error('Invalid SHA256SUMS entry');
  return [match[2], match[1]];
}));
for (const path of paths) {
  if (path === sums) continue;
  const name = basename(path);
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (expected.get(name) !== hash) throw new Error(`Checksum mismatch or missing entry: ${name}`);
  expected.delete(name);
  console.log(`  OK ${name}`);
}
if (expected.size) throw new Error('SHA256SUMS contains unstaged artifacts');
JS
fi

exit $rc
