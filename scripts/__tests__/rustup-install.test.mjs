import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('job-scoped rustup installation forbids profile modification and exposes only its bin directory', t => {
  const temp = mkdtempSync(join(tmpdir(), 'smirk-rustup-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const bin = join(temp, 'bin'); mkdirSync(bin);
  const args = join(temp, 'installer-args');
  const pathOutput = join(temp, 'path-output');
  writeFileSync(join(bin, 'curl'), '#!/bin/bash\nprintf "installer fixture\\n"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'sh'), '#!/bin/bash\nwhile read -r line; do :; done\nprintf "%s\\n" "$@" > "$TEST_INSTALLER_ARGS"\n', { mode: 0o755 });
  const run = changes => spawnSync('/bin/bash', [resolve('scripts/ci/install-rustup-job-scoped.sh')], {
    env: { ...process.env, PATH: bin, CARGO_HOME: join(temp, 'cargo'), RUSTUP_HOME: join(temp, 'rustup'),
      GITHUB_PATH: pathOutput, TEST_INSTALLER_ARGS: args, ...changes }, encoding: 'utf8',
  });
  const installed = run({});
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(readFileSync(args, 'utf8').split('\n').includes('--no-modify-path'));
  assert.equal(readFileSync(pathOutput, 'utf8').trim(), join(temp, 'cargo', 'bin'));

  rmSync(args); rmSync(pathOutput);
  const refused = run({ CARGO_HOME: '' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /CARGO_HOME.+unset/);
  assert.equal(existsSync(args), false);
  assert.equal(existsSync(pathOutput), false);

  writeFileSync(join(bin, 'rustup'), '#!/bin/bash\nexit 99\n', { mode: 0o755 });
  const existing = run({});
  assert.equal(existing.status, 0, existing.stderr);
  assert.equal(existsSync(args), false);
  assert.equal(existsSync(pathOutput), false);
});
