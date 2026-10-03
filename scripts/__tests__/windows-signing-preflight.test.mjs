import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { preflightWindowsSigning } from '../ci/windows-signing-preflight.mjs';

function broker(t) {
  const root = mkdtempSync(join(tmpdir(), 'smirk-signing-broker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'in'));
  mkdirSync(join(root, 'out'));
  return root;
}

test('a clear breaker and real queues admit, without claiming broker or token liveness', t => {
  const evidence = preflightWindowsSigning(broker(t));
  assert.equal(evidence.breaker, 'clear');
  assert.notEqual(evidence.brokerLiveness, 'observed-running');
});

test('a tripped breaker refuses without echoing its contents', t => {
  const root = broker(t);
  writeFileSync(join(root, 'SIGNING_LOCKED'), 'UNTRUSTED_BREAKER_DETAIL');
  assert.throws(() => preflightWindowsSigning(root), error => /breaker.*tripped/.test(error.message)
    && !error.message.includes('UNTRUSTED_BREAKER_DETAIL'));
});

test('each queue must exist as a real directory, and the refusal names which one', t => {
  for (const name of ['in', 'out']) {
    const missing = broker(t);
    rmSync(join(missing, name), { recursive: true });
    assert.throws(() => preflightWindowsSigning(missing), new RegExp(`${name} queue is missing`));

    const file = broker(t);
    rmSync(join(file, name), { recursive: true });
    writeFileSync(join(file, name), '');
    assert.throws(() => preflightWindowsSigning(file), new RegExp(`${name} queue is not a real directory`));

    const redirected = broker(t);
    const elsewhere = mkdtempSync(join(tmpdir(), 'smirk-signing-elsewhere-'));
    t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
    rmSync(join(redirected, name), { recursive: true });
    symlinkSync(elsewhere, join(redirected, name));
    assert.throws(() => preflightWindowsSigning(redirected), new RegExp(`${name} queue is not a real directory`));
  }
});

test('unreadable broker metadata refuses with its errno, never a raw message', () => {
  const io = { lstatSync: () => { throw Object.assign(new Error('PRIVATE_DETAIL'), { code: 'EACCES' }); } };
  assert.throws(() => preflightWindowsSigning('C:\\signing', io),
    error => /cannot be read \(EACCES\)/.test(error.message) && !error.message.includes('PRIVATE_DETAIL'));
});

test('the preflight never depends on task metadata the runner account cannot read', () => {
  const source = readFileSync(new URL('../ci/windows-signing-preflight.mjs', import.meta.url), 'utf8');
  const code = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /ScheduledTask|powershell|spawnSync/);
});

test('Windows broker admission executes before dependencies and all compilation', () => {
  const workflow = yaml.load(readFileSync(new URL('../../.gitea/workflows/desktop-build.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.build.steps;
  const guardIndex = steps.findIndex(step => step.run === 'node scripts/ci/windows-signing-preflight.mjs');
  assert.ok(guardIndex >= 0);
  assert.equal(steps[guardIndex].if, "matrix.os_label == 'windows'");
  assert.ok(!steps[guardIndex]['continue-on-error']);
  for (const [index, step] of steps.entries()) {
    if (/\b(npm (install|ci)|make wasm|cargo |rustup toolchain install)\b/.test(step.run ?? '')
        || step.uses?.startsWith('actions/setup-node@')) {
      assert.ok(guardIndex < index, `${step.name} must follow broker admission`);
    }
  }
});

test('the signing step verifies what ships and refuses on timeout without retrying', () => {
  const script = readFileSync(new URL('../../packages/desktop/src-tauri/scripts/sign-windows.ps1', import.meta.url), 'utf8');
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /TimeStamperCertificate/);
  assert.match(script, /timed out/);
  assert.match(script, /ReparsePoint/);
});
