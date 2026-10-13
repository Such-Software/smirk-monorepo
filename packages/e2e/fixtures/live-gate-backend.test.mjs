// The C-tips and E-swaps live gates judge the backend named by the environment
// they are given, never the process's own. On 2026-10-13 the C-tips gate test
// failed only inside the release run, where the process named production and the
// test's environment did not grant ALLOW_PROD_WRITES. No browser, no backend.
//
//   node --import tsx --test packages/e2e/fixtures/live-gate-backend.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveGateReason } from './C-tips-live.ts';
import { laneGates } from './E-swaps-live.ts';

const SHARED = 'https://backend.example/api/v1';
const LOOPBACK = 'http://127.0.0.1:8085/api/v1';

function custodyFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'live-gate-backend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'wallets.env');
  writeFileSync(file, '', { mode: 0o600 });
  return file;
}

function cTipsOpen(custody) {
  return {
    C_TIPS_INVOCATION: 'gate-test-backend',
    E2E_LIVE: '1',
    E2E_LIVE_MONEY: '1',
    SMOKE_WALLET_FILE: custody,
    FOOTAGE: 'guarded',
  };
}

test('the C-tips gate refuses a shared backend named by its environment until ALLOW_PROD_WRITES is set', (t) => {
  const open = cTipsOpen(custodyFile(t));
  assert.match(liveGateReason({ ...open, BACKEND_URL: SHARED }), /ALLOW_PROD_WRITES=1/);
  assert.equal(liveGateReason({ ...open, BACKEND_URL: SHARED, ALLOW_PROD_WRITES: '1' }), null);
  assert.equal(liveGateReason({ ...open, BACKEND_URL: LOOPBACK }), null);
  assert.match(liveGateReason({ ...open, BACKEND_URL: 'not a url' }), /ALLOW_PROD_WRITES=1/, 'an unparseable URL counts as shared');
});

test('the E-swaps gate grants writes to a shared backend named by its environment only with ALLOW_PROD_WRITES', () => {
  assert.equal(laneGates({ BACKEND_URL: SHARED }).prodWrites, false);
  assert.equal(laneGates({ BACKEND_URL: SHARED, ALLOW_PROD_WRITES: '1' }).prodWrites, true);
  assert.equal(laneGates({ BACKEND_URL: LOOPBACK }).prodWrites, true);
  assert.equal(laneGates({}).prodWrites, true, 'unset means the local default backend');
});

test('neither gate reads the backend from the process when it is given an environment', (t) => {
  const custody = custodyFile(t);
  const here = fileURLToPath(new URL('.', import.meta.url));
  const probe = `
    const { liveGateReason } = await import('./C-tips-live.ts');
    const { laneGates } = await import('./E-swaps-live.ts');
    const env = JSON.parse(process.argv[1]);
    console.log(JSON.stringify({ cTips: liveGateReason(env), eSwaps: laneGates({}).prodWrites }));
  `;
  // The process names a shared backend and grants nothing; the given environment names none.
  const processEnv = { ...process.env, BACKEND_URL: SHARED };
  delete processEnv.ALLOW_PROD_WRITES;
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', probe, JSON.stringify(cTipsOpen(custody))],
    { cwd: here, env: processEnv, encoding: 'utf8' },
  );
  const verdict = JSON.parse(out.trim().split('\n').pop());
  assert.equal(verdict.cTips, null);
  assert.equal(verdict.eSwaps, true);
});
