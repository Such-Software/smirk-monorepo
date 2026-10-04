// The macOS disk image must leave CI signed, notarized and stapled. The v0.3.0
// image shipped unsigned around a notarized app, and Gatekeeper rejected the
// image itself ("no usable signature").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(join(root, '.gitea/workflows/desktop-build.yml'), 'utf8');
const signer = readFileSync(join(root, 'scripts/ci/sign-macos-dmg.sh'), 'utf8');
const at = (needle) => {
  const index = workflow.indexOf(needle);
  assert.notEqual(index, -1, `workflow lacks: ${needle}`);
  return index;
};

test('the disk image is signed, notarized and stapled before provenance records it', () => {
  const signing = at('bash scripts/ci/sign-macos-dmg.sh');
  const record = at('node scripts/release-artifacts.mjs record --dir "$dest"');
  const keyRemoval = at('Remove temporary notarization key');
  assert.ok(signing < record, 'the image must be signed before release-artifacts records it');
  assert.ok(signing < keyRemoval, 'notarization needs the API key before it is removed');
  for (const step of ['codesign --force --timestamp', 'xcrun notarytool submit', 'xcrun stapler staple', 'xcrun stapler validate', 'spctl --assess --type open']) {
    assert.ok(signer.includes(step), `signing script lacks: ${step}`);
  }
});

test('staging refuses instead of shipping an unsigned image or a bare app', () => {
  const staging = workflow.slice(at('Archive bundles (space-free)'), at('node scripts/release-artifacts.mjs record --dir "$dest"'));
  assert.ok(!/hdiutil create/.test(staging), 'staging must not build its own unsigned image');
  assert.match(staging, /disk image is missing; refusing/);
});

test('the certificate password never reaches a command line', () => {
  for (const line of signer.split('\n')) {
    if (/APPLE_CERTIFICATE_PASSWORD/.test(line) && !/^\s*#/.test(line)) {
      assert.ok(/env:APPLE_CERTIFICATE_PASSWORD|for name in|\$\{!name/.test(line) || /^\s*APPLE_[A-Z_ ]+\\?$/.test(line.trim()),
        `password may reach argv: ${line.trim()}`);
    }
  }
});
