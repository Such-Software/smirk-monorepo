// The F-legacy-recovery lane's gates must stay closed by default, its move
// fixtures must refuse amounts above the cap before anything moves, and its
// wallet lock must keep two live runs off one demo wallet:
//   node --test packages/e2e/fixtures/F-legacy-recovery-lane.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const locks = mkdtempSync(join(tmpdir(), 'f-legacy-locks-'));
process.env.E2E_LOCK_DIR = locks;
const lane = await import('./F-legacy-recovery-lane.mjs');

const PROD = 'https://api.smirk.cash/api/v1';

test('gates are closed by default and each opens only on its own approval', () => {
  const none = lane.laneGates({ BACKEND_URL: PROD });
  assert.deepEqual(none, { declared: false, live: false, money: false, prodWrites: false });
  // E2E_LIVE alone does not declare the lane's tests: only its own config sets E2E_LANE.
  assert.equal(lane.laneGates({ E2E_LIVE: '1', BACKEND_URL: PROD }).declared, false);
  const live = lane.laneGates({ E2E_LIVE: '1', E2E_LANE: lane.LANE_ID, BACKEND_URL: PROD });
  assert.equal(live.declared, true);
  assert.match(lane.writeRefusal(live), /^opt-in: /);
  assert.match(lane.moneyRefusal(live), /^opt-in: /);
  // Money without the shared-backend write approval is still refused.
  assert.match(lane.moneyRefusal(lane.laneGates({ E2E_LIVE: '1', E2E_LIVE_MONEY: '1', BACKEND_URL: PROD })), /ALLOW_PROD_WRITES/);
  const all = lane.laneGates({ E2E_LIVE: '1', E2E_LANE: lane.LANE_ID, E2E_LIVE_MONEY: '1', ALLOW_PROD_WRITES: '1', BACKEND_URL: PROD });
  assert.equal(lane.moneyRefusal(all), null);
  // A loopback backend is not shared.
  assert.equal(lane.laneGates({ BACKEND_URL: 'http://127.0.0.1:8080/api/v1' }).prodWrites, true);
  // The skip guard's floor rises as approvals open more tests.
  assert.ok(lane.expectedExecuted(all, 2) > lane.expectedExecuted(live, 2));
  assert.ok(lane.expectedExecuted(all, 2) > lane.expectedExecuted(all, 1));
});

test('skip reasons carry the prefixes the skip guard excuses', () => {
  assert.match(lane.optIn('x'), /^opt-in: /);
  assert.match(lane.noFixture('x'), /^no fixture: /);
});

test('move fixtures default to one UTXO and one Cryptonote move among the demo wallets', () => {
  const moves = lane.moveScenarios({});
  assert.deepEqual(moves.map((m) => m.kind).sort(), ['cryptonote', 'utxo']);
  for (const m of moves) {
    assert.notEqual(m.funder, m.target);
    assert.ok(lane.WALLET_NAMES.includes(m.funder) && lane.WALLET_NAMES.includes(m.target));
    assert.ok(m.amountAtomic > 0n);
  }
  assert.ok(moves.some((m) => m.kind === 'cryptonote' && (m.source === 'v1' || m.source === 'v2')));
});

test('a move amount above the cap, or any malformed move setting, refuses', () => {
  assert.throws(() => lane.moveScenarios({ E2E_LEGACY_MOVE_ASSETS: 'ltc', E2E_LEGACY_MOVE_LTC_AMOUNT: '0.2' }), /cap/);
  assert.throws(() => lane.moveScenarios({ E2E_LEGACY_MOVE_ASSETS: 'wow', E2E_LEGACY_MOVE_WOW_AMOUNT: '20' }), /cap/);
  assert.throws(() => lane.moveScenarios({ E2E_LEGACY_MOVE_ASSETS: 'ltc', E2E_LEGACY_MOVE_LTC_AMOUNT: '0' }), /above zero/);
  assert.throws(() => lane.moveScenarios({ E2E_LEGACY_MOVE_ASSETS: 'ltc', E2E_LEGACY_MOVE_LTC_AMOUNT: '2e-4' }), /plain decimal/);
  assert.throws(() => lane.moveScenarios({ E2E_LEGACY_MOVE_ASSETS: 'ltc', E2E_LEGACY_MOVE_LTC_AMOUNT: '0.000000001' }), /decimals/);
  assert.throws(() => lane.moveScenarios({ E2E_LEGACY_MOVE_ASSETS: 'wow', E2E_LEGACY_MOVE_WOW_TARGET: 'alice' }), /different/);
  assert.throws(() => lane.moveScenarios({ E2E_LEGACY_MOVE_ASSETS: 'wow', E2E_LEGACY_MOVE_WOW_FUNDER: 'mallory' }), /one of/);
  assert.throws(() => lane.moveScenarios({ E2E_LEGACY_MOVE_ASSETS: 'xmr', E2E_LEGACY_MOVE_XMR_SOURCE: 'm44' }), /v1 or v2/);
  assert.throws(() => lane.moveScenarios({ E2E_LEGACY_MOVE_ASSETS: 'doge' }), /not one of/);
  assert.throws(() => lane.moveScenarios({ E2E_LEGACY_MOVE_ASSETS: 'ltc,ltc' }), /twice/);
  assert.equal(lane.toAtomic('0.0002', 8), 20_000n);
  assert.equal(lane.toAtomic('2', 11), 200_000_000_000n);
});

test('preflight refuses a run that is not live, or that carries a phrase in its environment', () => {
  assert.throws(() => lane.lanePreflight({}), /E2E_LIVE=1/);
  assert.throws(() => lane.lanePreflight({ E2E_LIVE: '1', SMOKE_BOB_MNEMONIC: 'x' }), /SMOKE_BOB_MNEMONIC/);
  assert.throws(() => lane.lanePreflight({ E2E_LIVE: '1' }), /E2E_WALLET_FILE/);
  const loose = join(locks, 'custody');
  writeFileSync(loose, '');
  // Explicit, so a restrictive umask cannot turn this into an owner-only file.
  chmodSync(loose, 0o644);
  assert.throws(() => lane.lanePreflight({ E2E_LIVE: '1', E2E_WALLET_FILE: loose }), /owner-only/);
});

test('the wallet lock holds, releases, reclaims a dead holder and refuses another live run', async () => {
  try {
    const release = await lane.acquireWalletLock('alice');
    assert.equal(lane.walletLockHolder('alice')?.pid, process.pid);
    release();
    assert.equal(lane.walletLockHolder('alice'), null);
    assert.equal(existsSync(join(locks, 'demo-wallet-alice.lock')), false);

    // A holder whose process is gone is reclaimed.
    writeFileSync(join(locks, 'demo-wallet-bob.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, lane: 'C-tips' }));
    const releaseBob = await lane.acquireWalletLock('bob');
    assert.equal(lane.walletLockHolder('bob')?.pid, process.pid);
    releaseBob();

    // A live holder from another lane is refused at once, and preflight names it.
    writeFileSync(join(locks, 'demo-wallet-carol.lock'), JSON.stringify({ pid: process.ppid, lane: 'C-tips' }));
    await assert.rejects(lane.acquireWalletLock('carol'), /in use by another live run/);
    assert.equal(lane.walletLockHolder('carol')?.lane, 'C-tips');
  } finally {
    rmSync(locks, { recursive: true, force: true });
  }
});
