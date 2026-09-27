#!/usr/bin/env bash
# Validate the built app before any candidate archive is staged.
set -euo pipefail

fail() { echo "verify-macos-release: $1" >&2; exit 1; }
APP="${1:-}"
[ -n "$APP" ] && [ -d "$APP" ] || fail 'supply the built .app directory'
[ -n "${APPLE_TEAM_ID:-}" ] || fail 'expected Apple team is missing'

codesign --verify --deep --strict "$APP" || fail 'codesign rejected the built app; see its diagnostic above'
details="$(codesign --display --verbose=4 "$APP" 2>&1)" \
  || fail 'codesign could not read the built app identity'
team="$(printf '%s\n' "$details" | sed -n 's/^TeamIdentifier=//p')"
[ "$team" = "$APPLE_TEAM_ID" ] || fail 'built app signer does not match the expected Apple team'
printf '%s\n' "$details" | grep -q '^Authority=Developer ID Application:' \
  || fail 'built app has no Developer ID Application signature'
printf '%s\n' "$details" | grep -q '^CodeDirectory .*flags=.*runtime' \
  || fail 'built app does not enable hardened runtime'
xcrun stapler validate "$APP" || fail 'the built app has no valid notarization staple'
spctl --assess --type execute --verbose "$APP" || fail 'Gatekeeper rejected the built app'
echo 'Verified macOS Developer ID signature, expected team, hardened runtime, notarization staple, and Gatekeeper acceptance.'
