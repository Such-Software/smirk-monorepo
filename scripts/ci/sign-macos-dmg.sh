#!/usr/bin/env bash
# Build the macOS disk image from the notarized app, then sign, notarize and
# staple the image itself, before release provenance records it.
#
#   scripts/ci/sign-macos-dmg.sh APP_DIR OUTPUT_DMG
#
# The app inside is already Developer ID signed, notarized and stapled. Without
# this step the container was unsigned and Gatekeeper rejected the image itself
# ("no usable signature"). Every refusal names its cause; nothing is shipped
# unsigned.
#
# Inputs (environment): APPLE_CERTIFICATE (base64 PKCS#12),
# APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY, APPLE_TEAM_ID,
# APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_PATH. Secrets stay in
# environment variables and RUNNER_TEMP files; the certificate password never
# reaches a command line. A temporary keychain is created for this step and
# removed on every exit.
set -euo pipefail
umask 077

fail() { echo "sign-macos-dmg: $1" >&2; exit 1; }

APP="${1:-}"
DMG="${2:-}"
[ -n "$APP" ] && [ -d "$APP" ] || fail 'supply the notarized .app directory'
[ -n "$DMG" ] || fail 'supply the output .dmg path'
for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_TEAM_ID \
            APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH RUNNER_TEMP; do
  [ -n "${!name:-}" ] || fail "$name is missing; refusing to ship an unsigned disk image"
done
[ -f "$APPLE_API_KEY_PATH" ] || fail 'the notarization API key file is missing'

work="$(mktemp -d "$RUNNER_TEMP/smirk-dmg-sign.XXXXXX")"
keychain="$work/signing.keychain-db"
original_keychains=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"; line="${line%\"}"; line="${line#\"}"
  [ -n "$line" ] && original_keychains+=("$line")
done < <(security list-keychains -d user)

cleanup() {
  if [ "${#original_keychains[@]}" -gt 0 ]; then
    security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

# Re-wrap the identity under a one-use random password so the real certificate
# password is read from the environment only (openssl env:), never from argv.
# System LibreSSL with SHA-1/3DES keeps the re-wrapped file importable by
# `security`, which rejects some newer PKCS#12 encodings.
transfer="$(/usr/bin/openssl rand -hex 24)"
keychain_password="$(/usr/bin/openssl rand -hex 24)"
printf '%s' "$APPLE_CERTIFICATE" | /usr/bin/openssl base64 -d -A > "$work/identity.p12"
/usr/bin/openssl pkcs12 -in "$work/identity.p12" -passin env:APPLE_CERTIFICATE_PASSWORD \
  -nodes -out "$work/identity.pem" 2>/dev/null \
  || fail 'the Developer ID identity does not open with its password'
TRANSFER_PASSWORD="$transfer" /usr/bin/openssl pkcs12 -export -in "$work/identity.pem" -out "$work/transfer.p12" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -passout env:TRANSFER_PASSWORD 2>/dev/null \
  || fail 'could not re-wrap the Developer ID identity for import'
rm -f "$work/identity.p12" "$work/identity.pem"

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 1800 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/transfer.p12" -k "$keychain" -P "$transfer" -T /usr/bin/codesign >/dev/null \
  || fail 'could not import the Developer ID identity into the temporary keychain'
rm -f "$work/transfer.p12"
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null \
  || fail 'could not authorize codesign for the temporary keychain'
security list-keychains -d user -s "$keychain" ${original_keychains[@]+"${original_keychains[@]}"}
security find-identity -v -p codesigning "$keychain" | grep -qF "\"$APPLE_SIGNING_IDENTITY\"" \
  || fail 'the expected Developer ID Application identity is not in the imported certificate'

# Build the image from the notarized app (pure CLI; Tauri's bundle_dmg.sh needs
# a WindowServer the daemon runner does not have).
source="$work/dmg-source"
mkdir -p "$source"
cp -R "$APP" "$source/"
ln -s /Applications "$source/Applications"
rm -f "$DMG"
hdiutil create -volname "Smirk Wallet" -srcfolder "$source" -ov -format UDZO "$DMG" >/dev/null \
  || fail 'hdiutil could not build the disk image'

codesign --force --timestamp --keychain "$keychain" --sign "$APPLE_SIGNING_IDENTITY" "$DMG" \
  || fail 'codesign could not sign the disk image'
codesign --verify --strict "$DMG" || fail 'the signed disk image does not verify'
details="$(codesign --display --verbose=4 "$DMG" 2>&1)" || fail 'codesign could not read the disk image signature'
[ "$(printf '%s\n' "$details" | sed -n 's/^TeamIdentifier=//p')" = "$APPLE_TEAM_ID" ] \
  || fail 'the disk image signer does not match the expected Apple team'

result="$work/notarytool.json"
xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" --wait --timeout 45m --output-format json > "$result" \
  || fail 'notarytool submission failed; see its diagnostic above'
status="$(/usr/bin/plutil -extract status raw -o - "$result" 2>/dev/null || true)"
submission="$(/usr/bin/plutil -extract id raw -o - "$result" 2>/dev/null || true)"
[ "$status" = Accepted ] || fail "notarization returned status '${status:-unknown}' for submission ${submission:-unknown}"

xcrun stapler staple "$DMG" >/dev/null || fail 'could not staple the notarization ticket to the disk image'
xcrun stapler validate "$DMG" || fail 'the disk image has no valid notarization staple'
spctl --assess --type open --context context:primary-signature --verbose "$DMG" \
  || fail 'Gatekeeper rejected the signed disk image'
echo "Signed, notarized (submission $submission) and stapled $(basename "$DMG")."
