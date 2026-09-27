import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordArtifacts, verifyArtifacts } from '../release-artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const version = '0.3.0';
const signingFingerprint = 'C'.repeat(40);

function release(t) {
  const directory = mkdtempSync(join(tmpdir(), 'smirk-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = {
    extension: ['chrome', 'firefox', 'source'].map((variant) => `smirk-wallet-${variant}-v${version}.zip`),
    macos: ['Smirk Wallet.dmg', 'Smirk Wallet.app.tar.gz'],
    linux: ['Smirk.AppImage', 'Smirk.deb'],
    windows: ['Smirk-setup.exe', 'Smirk-portable.exe', 'Smirk-setup-unsigned.exe', 'Smirk-portable-unsigned.exe'],
  };
  for (const [platform, names] of Object.entries(files)) {
    const destination = platform === 'extension' ? directory : join(directory, platform);
    mkdirSync(destination, { recursive: true });
    for (const name of names) writeFileSync(join(destination, name), `test artifact ${name}`);
    if (platform === 'extension') writeFileSync(join(destination, `TOOLCHAIN-v${version}.txt`), `# commit: ${source}\n`);
    recordArtifacts(destination, platform, version, source, tree);
  }
  return directory;
}

test('complete candidates verify against one exact source commit and tree', (t) => {
  assert.deepEqual(verifyArtifacts(release(t), version, source), { sourceCommit: source, sourceTree: tree });
});

test('a different build of the same version cannot pass', (t) => {
  assert.throws(() => verifyArtifacts(release(t), version, 'c'.repeat(40)), /source commit/);
});

test('mixed platform source trees cannot pass', (t) => {
  const directory = release(t);
  recordArtifacts(join(directory, 'linux'), 'linux', version, source, 'd'.repeat(40));
  assert.throws(() => verifyArtifacts(directory, version, source), /source tree/);
});

test('missing platform provenance refuses instead of borrowing checkout artifacts', (t) => {
  const directory = release(t);
  rmSync(join(directory, 'macos'), { recursive: true });
  assert.throws(() => verifyArtifacts(directory, version, source), /macos.+missing/);
});

test('changed artifact bytes and unrecorded artifacts refuse', (t) => {
  const directory = release(t);
  writeFileSync(join(directory, 'linux', 'Smirk.AppImage'), 'different bytes');
  assert.throws(() => verifyArtifacts(directory, version, source), /digest differs/);
  recordArtifacts(join(directory, 'linux'), 'linux', version, source, tree);
  writeFileSync(join(directory, 'linux', 'stale.AppImage'), 'old release');
  assert.throws(() => verifyArtifacts(directory, version, source), /unrecorded artifact/);
});

test('missing required deliverables refuse before a provenance record is written', (t) => {
  const directory = release(t);
  rmSync(join(directory, 'windows', 'Smirk-setup.exe'));
  assert.throws(() => recordArtifacts(join(directory, 'windows'), 'windows', version, source, tree), /signed installer/);
});

test('filename normalization preserves evidence, but ambiguous copies refuse', (t) => {
  const directory = release(t);
  const original = join(directory, 'macos', 'Smirk Wallet.dmg');
  const normalized = join(directory, 'macos', 'Smirk.Wallet.dmg');
  renameSync(original, normalized);
  assert.doesNotThrow(() => verifyArtifacts(directory, version, source));
  writeFileSync(original, readFileSync(normalized));
  assert.throws(() => verifyArtifacts(directory, version, source), /ambiguous/);
});

test('symlink inputs cannot replace recorded artifacts', (t) => {
  const directory = release(t);
  const path = join(directory, 'linux', 'Smirk.AppImage');
  const target = join(directory, 'outside');
  renameSync(path, target);
  symlinkSync(target, path);
  assert.throws(() => verifyArtifacts(directory, version, source), /regular file/);
});

test('signing refuses incomplete input before calling the signer', (t) => {
  const directory = release(t);
  rmSync(join(directory, `smirk-wallet-firefox-v${version}.zip`));
  const result = spawnSync('bash', [join(root, 'scripts/sign-release.sh'), version,
    '--bundle-dir', directory, '--expect-commit', source], { env: { ...process.env, SMIRK_SIGNING_KEY: signingFingerprint }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /firefox.+missing/);
  assert.equal(existsSync(join(directory, 'SHA256SUMS-v0.3.0.txt')), false);
});

test('release signing verifies flat published checksums against staged platform directories', (t) => {
  const directory = release(t);
  const bin = join(directory, 'test-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gpg'), `#!/usr/bin/env bash
set -eu
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then printf 'fixture signature' > "$2"; exit 0; fi
  shift
done
echo '[GNUPG:] VALIDSIG ${signingFingerprint} 2026-09-27 0 0 4 0 22 8 00 ${signingFingerprint}'
`, { mode: 0o755 });
  const args = [join(root, 'scripts/sign-release.sh'), version, '--bundle-dir', directory, '--expect-commit', source];
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SMIRK_SIGNING_KEY: `${signingFingerprint}!` };
  const signed = spawnSync('bash', args, { env, encoding: 'utf8' });
  assert.equal(signed.status, 0, signed.stderr + signed.stdout);
  assert.ok(existsSync(join(directory, 'macos', 'Smirk Wallet.dmg.asc')));
  const verified = spawnSync('bash', [...args, '--verify'], { env, encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
});

for (const [name, output, diagnostics, exitCode] of [
  ['another signer despite forged diagnostic evidence', `[GNUPG:] VALIDSIG ${'D'.repeat(40)}`, `[GNUPG:] VALIDSIG ${signingFingerprint}`, 0],
  ['human-readable good signature without machine evidence', `Good signature using key ${signingFingerprint}`, '', 0],
  ['revoked signature', `[GNUPG:] VALIDSIG ${signingFingerprint}\n[GNUPG:] REVKEYSIG`, '', 0],
  ['ambiguous valid signatures', `[GNUPG:] VALIDSIG ${signingFingerprint}\n[GNUPG:] VALIDSIG ${'D'.repeat(40)}`, '', 0],
  ['failure even with expected fingerprint', `[GNUPG:] VALIDSIG ${signingFingerprint}\n[GNUPG:] FAILURE`, '', 1],
]) {
  test(`release verification refuses ${name}`, (t) => {
    const directory = release(t);
    const bin = join(directory, 'test-bin'); mkdirSync(bin);
    const executable = join(bin, 'gpg');
    const script = (status, stderr = '', code = 0) => `#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then printf 'fixture signature' > "$2"; exit 0; fi
  shift
done
printf '%s\\n' '${status}'
printf '%s\\n' '${stderr}' >&2
exit ${code}
`;
    writeFileSync(executable, script(`[GNUPG:] VALIDSIG ${signingFingerprint}`), { mode: 0o755 });
    const args = [join(root, 'scripts/sign-release.sh'), version, '--bundle-dir', directory, '--expect-commit', source];
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SMIRK_SIGNING_KEY: signingFingerprint };
    const signed = spawnSync('bash', args, { env, encoding: 'utf8' });
    assert.equal(signed.status, 0, signed.stderr);
    writeFileSync(executable, script(output, diagnostics, exitCode));
    const checked = spawnSync('bash', [...args, '--verify'], { env, encoding: 'utf8' });
    assert.notEqual(checked.status, 0);
    assert.match(checked.stderr, /differs from expected|no VALIDSIG|validity|multiple VALIDSIG|GPG verification failed/);
  });
}

test('short or absent signing selectors refuse before output mutation', (t) => {
  const directory = release(t);
  for (const selector of ['', '1234567890ABCDEF']) {
    const checked = spawnSync('bash', [join(root, 'scripts/sign-release.sh'), version, '--bundle-dir', directory, '--expect-commit', source], {
      env: { ...process.env, SMIRK_SIGNING_KEY: selector }, encoding: 'utf8',
    });
    assert.notEqual(checked.status, 0);
    assert.match(checked.stderr, /full.+fingerprint/);
    assert.equal(existsSync(join(directory, `SHA256SUMS-v${version}.txt`)), false);
  }
});
