#!/usr/bin/env bash
# Area H macOS desktop smoke for the Smirk Wallet v0.3.1 release candidate
# (run 11204): verify the disk image, run the signed app isolated from the
# installed /Applications/Smirk Wallet.app and its data, and record the flow.
#
#   1. Verify: the dmg hash equals its release provenance; hdiutil verify;
#      the stapled ticket validates; Gatekeeper accepts the dmg and the app as
#      Notarized Developer ID; codesign --verify --deep --strict passes; the
#      team, bundle id and version are the release's. The app is copied into
#      the run's owner-only directory; the image is detached.
#   2. Prove isolation: snapshot every Smirk path in the real ~/Library, launch
#      the copy with HOME, CFFIXED_USER_HOME and TMPDIR in a scratch home,
#      require the fresh welcome screen (an existing wallet would show its lock
#      screen), quit, and require the real paths unchanged and the scratch home
#      written. Any difference refuses: use a dedicated macOS test user then.
#   3. Record (scripts/H-cross-browser-desktop-macos-driver.mjs): import alice
#      with recording stopped, Home balances read from the accessibility tree
#      and compared with the Chromium reference, lock and unlock with recording
#      stopped around the password, a history entry whose explorer link opens
#      the default browser, quit. The real paths are checked again afterwards.
#
# Usage, from the monorepo root after npm ci:
#   packages/e2e/scripts/desktop-smoke-macos.sh --verify-only
#   packages/e2e/scripts/desktop-smoke-macos.sh --isolation-only
#   E2E_LIVE=1 FOOTAGE=guarded ALLOW_PROD_WRITES=1 \
#     packages/e2e/scripts/desktop-smoke-macos.sh --wallet-file <custody file> \
#       [--reference <balances-reference.json>] [--screen <avfoundation index>] [--keep-app]
#
# Needs: Accessibility and Screen Recording permission for the terminal, the
# installed Smirk Wallet not running, and Focus (Do Not Disturb) on so no
# notification lands inside the recorded window rectangle.
set -euo pipefail

refuse() { printf 'desktop smoke refused: %s\n' "$*" >&2; exit "${CODE:-1}"; }
note() { printf '%s\n' "$*"; }

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
version=0.3.1
bundle_id=cash.smirk.wallet
team_id=D8PL9F7X33
staged="$HOME/Build/smirk-release/v0.3.1-run-11204/staged"
root="$HOME/Build/smirk-e2e/v0.3.1-run-11204"
dmg="" wallet_file="" reference="" screen="" font="" mode=full keep_app=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dmg) dmg=$2; shift 2 ;;
    --wallet-file) wallet_file=$2; shift 2 ;;
    --reference) reference=$2; shift 2 ;;
    --screen) screen=$2; shift 2 ;;
    --font) font=$2; shift 2 ;;
    --out-root) root=$2; shift 2 ;;
    --verify-only) mode=verify; shift ;;
    --isolation-only) mode=isolation; shift ;;
    --keep-app) keep_app=1; shift ;;
    *) refuse "unknown argument $1" ;;
  esac
done
dmg=${dmg:-$staged/macos/Smirk-Wallet-$version.dmg}
provenance=$(dirname "$dmg")/RELEASE-PROVENANCE-macos-v$version.json
reference=${reference:-$root/footage/H-cross-browser-desktop/balances-reference.json}
work="$root/work/H-cross-browser-desktop/macos"
out="$root/footage/H-cross-browser-desktop/macos-desktop"

# ---- cheap guards first -----------------------------------------------------
[ "$(uname -s)" = Darwin ] || refuse "this smoke runs on macOS only"
for tool in hdiutil spctl codesign xcrun ditto shasum plutil node swiftc pgrep stat; do
  command -v "$tool" >/dev/null 2>&1 || refuse "missing tool: $tool"
done
[ -f "$dmg" ] || refuse "no disk image at $dmg"
[ -f "$provenance" ] || refuse "no release provenance next to the disk image"
if [ "$mode" = full ]; then
  [ "${E2E_LIVE:-}" = 1 ] && [ "${FOOTAGE:-}" = guarded ] && [ "${ALLOW_PROD_WRITES:-}" = 1 ] \
    || refuse "set E2E_LIVE=1, FOOTAGE=guarded and ALLOW_PROD_WRITES=1 for the recorded flow"
  command -v ffmpeg >/dev/null 2>&1 || refuse "missing tool: ffmpeg"
  [ -n "$wallet_file" ] || refuse "--wallet-file is required (the owner-only custody file)"
  [ -f "$wallet_file" ] && [ ! -L "$wallet_file" ] || refuse "the custody file must be a regular file"
  [ "$(stat -f '%Lp' "$wallet_file")" = 600 ] || refuse "the custody file must have mode 0600"
  [ "$(stat -f '%u' "$wallet_file")" = "$(id -u)" ] || refuse "the custody file must be owned by $(id -un)"
fi
if [ "$mode" != verify ] && pgrep -f 'Smirk Wallet.app/Contents/MacOS/smirk-desktop' >/dev/null 2>&1; then
  refuse "a Smirk Wallet app is running; quit it so nothing shares its data or window focus"
fi

umask 077
mkdir -p "$work" && chmod 700 "$root" "$root/work" "$root/work/H-cross-browser-desktop" "$work"
mnt="$work/mnt" app_dir="$work/app" app="$work/app/Smirk Wallet.app" bin="$work/bin"
cleanup() {
  if [ -d "$mnt" ] && mount | grep -q " on $mnt "; then hdiutil detach "$mnt" -quiet || hdiutil detach "$mnt" -force -quiet || true; fi
  rm -rf "$work/home" "$work/probe-home"
  [ "$keep_app" = 1 ] || rm -rf "$app_dir"
}
trap cleanup EXIT

# ---- 1. verify the disk image and the app -----------------------------------
note "1. Verify $(basename "$dmg")"
expected=$(node -e '
  const hit = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).artifacts.find((a) => a.name.endsWith(".dmg"));
  process.stdout.write(hit ? hit.sha256 : "");' "$provenance")
actual=$(shasum -a 256 "$dmg" | awk '{print $1}')
[ -n "$expected" ] && [ "$actual" = "$expected" ] || refuse "the disk image hash does not match its release provenance"
note "   sha256 $actual matches the provenance"
hdiutil verify -quiet "$dmg" || refuse "hdiutil verify failed"
xcrun stapler validate -q "$dmg" || refuse "the stapled notarization ticket does not validate"
gk_dmg=$(spctl -a -t open --context context:primary-signature -vv "$dmg" 2>&1 || true)
printf '%s\n' "$gk_dmg" | grep -q ': accepted' || refuse "Gatekeeper rejects the disk image"
printf '%s\n' "$gk_dmg" | grep -q 'source=Notarized Developer ID' || refuse "the disk image is not a notarized Developer ID image"
note "   Gatekeeper accepts the image (Notarized Developer ID); stapled ticket valid"

rm -rf "$mnt" "$app_dir" && mkdir -p "$mnt" "$app_dir"
hdiutil attach -readonly -nobrowse -noautoopen -quiet -mountpoint "$mnt" "$dmg" || refuse "could not attach the disk image"
[ -d "$mnt/Smirk Wallet.app" ] || refuse "the image has no Smirk Wallet.app"
codesign --verify --deep --strict --verbose=2 "$mnt/Smirk Wallet.app" >/dev/null 2>&1 || refuse "codesign --verify --deep --strict fails on the app"
gk_app=$(spctl -a -t exec -vv "$mnt/Smirk Wallet.app" 2>&1 || true)
printf '%s\n' "$gk_app" | grep -q ': accepted' || refuse "Gatekeeper rejects the app"
printf '%s\n' "$gk_app" | grep -q 'source=Notarized Developer ID' || refuse "the app is not notarized Developer ID"
signing=$(codesign -dv "$mnt/Smirk Wallet.app" 2>&1 || true)
printf '%s\n' "$signing" | grep -q "^TeamIdentifier=$team_id\$" || refuse "the app is not signed by team $team_id"
printf '%s\n' "$signing" | grep -q "^Identifier=$bundle_id\$" || refuse "the app identifier is not $bundle_id"
plist="$mnt/Smirk Wallet.app/Contents/Info.plist"
[ "$(plutil -extract CFBundleShortVersionString raw -o - "$plist")" = "$version" ] || refuse "the app is not version $version"
[ "$(plutil -extract CFBundleIdentifier raw -o - "$plist")" = "$bundle_id" ] || refuse "the bundle id is not $bundle_id"
ditto "$mnt/Smirk Wallet.app" "$app"
hdiutil detach "$mnt" -quiet
codesign --verify --deep --strict "$app" >/dev/null 2>&1 || refuse "the copied app no longer verifies"
note "   app: codesign deep strict OK, Gatekeeper accepts (Notarized Developer ID), team $team_id, $bundle_id $version"
[ "$mode" = verify ] && { note "Verification passed."; exit 0; }

# ---- 2. prove isolation -----------------------------------------------------
note "2. Prove isolation from the installed app and its data"
mkdir -p "$bin"
swiftc -O -o "$bin/ax" "$here/H-cross-browser-desktop-macos-ax.swift" 2>/dev/null || refuse "could not build the accessibility helper"
[ "$("$bin/ax" trusted)" = '{"trusted":true}' ] \
  || refuse "grant Accessibility to this terminal (System Settings > Privacy & Security > Accessibility), then rerun"

real_paths=(
  "Library/Application Support/$bundle_id" "Library/Caches/$bundle_id" "Library/WebKit/$bundle_id"
  "Library/WebKit/smirk-desktop" "Library/HTTPStorages/$bundle_id" "Library/HTTPStorages/$bundle_id.binarycookies"
  "Library/Preferences/$bundle_id.plist" "Library/Saved Application State/$bundle_id.savedState" "Library/Logs/$bundle_id"
)
snapshot_real() {
  local p
  for p in "${real_paths[@]}"; do
    if [ -e "$HOME/$p" ]; then
      find "$HOME/$p" -print0 2>/dev/null | xargs -0 stat -f '%N|%z|%m' 2>/dev/null | sort
    else
      printf '%s|absent\n' "$HOME/$p"
    fi
  done
}
probe_home="$work/probe-home"
rm -rf "$probe_home" && mkdir -p "$probe_home/Library"
snapshot_real >"$work/real-before.txt"
CODE=3 node "$here/H-cross-browser-desktop-macos-driver.mjs" --probe --ax "$bin/ax" --app "$app" --home "$probe_home" \
  || { CODE=3 refuse "the isolated launch did not reach a fresh welcome screen; use a dedicated macOS test user"; }
sleep 3
snapshot_real >"$work/real-after.txt"
if ! cmp -s "$work/real-before.txt" "$work/real-after.txt"; then
  changed=$(diff "$work/real-before.txt" "$work/real-after.txt" | grep '^[<>]' | sed -E 's/^[<>] //; s/\|.*//' | sed "s#$HOME/##" | sort -u | head -5 | tr '\n' ' ')
  CODE=3 refuse "isolation failed: the launch changed ${changed}in the real Library. Run this smoke as a dedicated macOS test user instead"
fi
written=$(find "$probe_home" -type f | head -1)
[ -n "$written" ] || { CODE=3 refuse "isolation unproven: the app wrote nothing under the scratch home"; }
note "   isolated: real Library paths unchanged; the app wrote only to the scratch home"
rm -rf "$probe_home"
[ "$mode" = isolation ] && { note "Isolation proven."; exit 0; }

# ---- 3. recorded flow -------------------------------------------------------
note "3. Recorded desktop flow"
if [ -z "$screen" ]; then
  screen=$(ffmpeg -hide_banner -f avfoundation -list_devices true -i '' 2>&1 | sed -nE 's/.*\[([0-9]+)\] Capture screen 0.*/\1/p' | head -1)
  [ -n "$screen" ] || refuse "no avfoundation screen device; grant Screen Recording to this terminal or pass --screen"
fi
ffmpeg -hide_banner -loglevel error -y -f avfoundation -framerate 30 -i "$screen:none" -frames:v 1 -f null - \
  || refuse "screen capture failed; grant Screen Recording to this terminal (System Settings > Privacy & Security)"
mkdir -p "$out" && chmod 700 "$out"
home="$work/home"
rm -rf "$home" && mkdir -p "$home/Library"
snapshot_real >"$work/real-before.txt"
set +e
node "$here/H-cross-browser-desktop-macos-driver.mjs" --ax "$bin/ax" --app "$app" --home "$home" --out "$out" \
  --wallet-file "$wallet_file" --reference "$reference" --screen "$screen" ${font:+--font "$font"}
status=$?
set -e
sleep 3
snapshot_real >"$work/real-after.txt"
cmp -s "$work/real-before.txt" "$work/real-after.txt" || refuse "the recorded run changed the real Library; treat its data as shared and investigate"
note "   real Library paths unchanged after the run"
note "Footage and evidence: $out"
exit "$status"
