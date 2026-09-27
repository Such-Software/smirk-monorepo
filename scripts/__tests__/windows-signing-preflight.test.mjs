import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { assessSigningHistory, observeBroker, preflightWindowsSigning, readSigningHistory, requireRunningBroker } from '../ci/windows-signing-preflight.mjs';

const now = new Date(2026, 8, 27, 12, 0, 0).getTime();
const warm = 'warm 2026-09-27T11:00:00\r\n';

test('recent historical warmth plus observed broker liveness does not claim present token health', () => {
  const evidence = preflightWindowsSigning({ readHistory: () => warm,
    readBroker: () => ({ status: 'observed', state: 'Running' }), now });
  assert.equal(evidence.ageMs, 60 * 60 * 1000);
  assert.equal(evidence.brokerLiveness, 'observed-running');
  assert.equal(evidence.tokenLogin, 'unknown');
  assert.equal(Date.parse(evidence.lastSuccessfulKeepalive), now - evidence.ageMs);
});

test('invalid, future, cold and stale history refuse before the broker query', () => {
  for (const record of [undefined, '', 'warm', 'warm tomorrow', 'warm 2026-02-30T11:00:00',
    'warm 2026-13-27T11:00:00', 'warm 2026-09-27T24:00:00', 'warm 2026-09-27T11:60:00',
    'warm 2026-09-27T12:00:01', 'warm 2026-09-28T11:00:00', 'warm 2026-09-27T11:00:00 extra',
    'cold 2026-09-27T11:00:00', 'warm 2026-09-27T02:59:59', 'warm 2026-09-27T11:00:00\ncold 2026-09-27T11:01:00']) {
    let queried = false;
    assert.throws(() => preflightWindowsSigning({ readHistory: () => record, now,
      readBroker: () => { queried = true; return { status: 'observed', state: 'Running' }; } }));
    assert.equal(queried, false);
  }
  assert.doesNotThrow(() => assessSigningHistory('warm 2026-09-27T03:00:00', now));
  assert.doesNotThrow(() => assessSigningHistory('warm 2026-09-27T12:00:00', now));
  assert.throws(() => assessSigningHistory(warm, NaN), /clock/);
});

test('warm history cannot override a stopped, absent, unreadable or ambiguous broker', () => {
  for (const observation of [undefined, {}, { status: 'unknown' },
    { status: 'unknown', cause: 'query-failed', category: 'PermissionDenied', errorCode: -2147024891 },
    { status: 'unknown', cause: 'identity-mismatch' },
    ...['Disabled', 'Queued', 'Ready', 'Unknown', undefined, 'unexpected'].map(state => ({ status: 'observed', state }))]) {
    assert.throws(() => preflightWindowsSigning({ readHistory: () => warm, now, readBroker: () => observation }));
  }
  assert.throws(() => requireRunningBroker({ status: 'unknown', cause: 'query-failed',
    category: 'PermissionDenied', errorCode: -2147024891 }), /unknown.*permission denied.*-2147024891/);
  assert.throws(() => preflightWindowsSigning({ readHistory: () => warm, now,
    readBroker: () => { throw new Error('metadata query timed out'); } }), /timed out/);
});

test('observer execution is bounded and unavailable or malformed metadata cannot become health', () => {
  const result = observeBroker((command, args, options) => {
    assert.equal(command, 'powershell.exe');
    assert.ok(args.includes('-NonInteractive'));
    assert.ok(args.includes('-File'));
    assert.ok(options.timeout > 0 && options.timeout <= 10_000);
    assert.ok(options.maxBuffer > 0 && options.maxBuffer <= 16 * 1024);
    return { status: 0, stdout: '{"status":"observed","state":"Running"}\r\n' };
  });
  assert.equal(requireRunningBroker(result).brokerLiveness, 'observed-running');
  for (const result of [{ status: 1, stderr: 'UNTRUSTED_DETAIL' },
    { status: 0, stdout: 'not JSON' }, { error: { code: 'ENOENT' } }, { error: { code: 'ETIMEDOUT' } }]) {
    assert.throws(() => observeBroker(() => result), error => /unknown/.test(error.message)
      && !error.message.includes('UNTRUSTED_DETAIL'));
  }
});

test('a repeated local clock hour cannot prove the age of an offset-free keepalive record', () => {
  const moduleUrl = new URL('../ci/windows-signing-preflight.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { assessSigningHistory } from ${JSON.stringify(moduleUrl)};
    assert.throws(() => assessSigningHistory('warm 2026-11-01T01:30:00',
      new Date('2026-11-01T08:00:00Z').getTime()), /ambiguous/);
  `], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('filesystem admission refuses breaker and unavailable evidence without reading arbitrary contents', t => {
  const root = mkdtempSync(join(tmpdir(), 'smirk-signing-metadata-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => readSigningHistory(root), /queue/);
  mkdirSync(join(root, 'in'));
  assert.throws(() => readSigningHistory(root), /history.*missing/);
  writeFileSync(join(root, 'token-state.txt'), warm);
  assert.equal(readSigningHistory(root), warm);
  writeFileSync(join(root, 'SIGNING_LOCKED'), 'UNTRUSTED_BREAKER_DETAIL');
  assert.throws(() => readSigningHistory(root), error => /breaker.*tripped/.test(error.message)
    && !error.message.includes('UNTRUSTED_BREAKER_DETAIL'));
  rmSync(join(root, 'SIGNING_LOCKED'));
  writeFileSync(join(root, 'token-state.txt'), 'x'.repeat(129));
  assert.throws(() => readSigningHistory(root), /too large/);
  assert.throws(() => readSigningHistory(root, { statSync: () => { throw Object.assign(new Error('PRIVATE_DETAIL'), { code: 'EACCES' }); },
    readFileSync: () => assert.fail('unreadable metadata must refuse before reading contents') }),
  error => /unknown.*EACCES/.test(error.message) && !error.message.includes('PRIVATE_DETAIL'));
});

test('Windows metadata gate executes before dependencies and all compilation', () => {
  const workflow = yaml.load(readFileSync(new URL('../../.gitea/workflows/desktop-build.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.build.steps;
  const guardIndex = steps.findIndex(step => step.run === 'node scripts/ci/windows-signing-preflight.mjs');
  assert.ok(guardIndex >= 0);
  assert.equal(steps[guardIndex].if, "matrix.os_label == 'windows'");
  assert.ok(!steps[guardIndex]['continue-on-error']);
  for (const [index, step] of steps.entries()) {
    if (/\b(npm (install|ci)|make wasm|cargo |rustup toolchain install)\b/.test(step.run ?? '')
        || step.uses?.startsWith('actions/setup-node@')) {
      assert.ok(guardIndex < index, `${step.name} must follow signing metadata admission`);
    }
  }
});
