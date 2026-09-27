import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../verify-macos-release.sh');

function check(t, failure = '') {
  const directory = mkdtempSync(join(tmpdir(), 'smirk-macos-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = join(directory, 'Test.app');
  mkdirSync(app);
  for (const tool of ['codesign', 'xcrun', 'spctl']) {
    writeFileSync(join(directory, tool), `#!/usr/bin/env bash
set -eu
if [ "$FAIL_STEP" = '${tool}' ]; then echo 'fixture verification failure' >&2; exit 1; fi
if [ '${tool}' = codesign ] && [ "$1" = --display ]; then
  echo "TeamIdentifier=$TEST_TEAM"
  echo 'Authority=Developer ID Application: Test fixture'
  echo 'CodeDirectory v=20500 flags=0x10000(runtime)'
fi
`, { mode: 0o755 });
  }
  return spawnSync('bash', [script, app], {
    encoding: 'utf8', env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`,
      APPLE_TEAM_ID: 'TESTTEAM', TEST_TEAM: failure === 'wrong-team' ? 'OTHERTEAM' : 'TESTTEAM',
      FAIL_STEP: failure,
    },
  });
}

test('macOS release requires all signing, staple, and Gatekeeper checks', (t) => {
  const result = check(t);
  assert.equal(result.status, 0, result.stderr);
});

for (const failure of ['codesign', 'xcrun', 'spctl', 'wrong-team']) {
  test(`macOS release refuses ${failure} verification failure`, (t) => {
    const result = check(t, failure);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /verify-macos-release:/);
  });
}
