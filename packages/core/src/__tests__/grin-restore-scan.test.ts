/**
 * The priced Grin scan shared by the balance read and every spend-side scan.
 *
 * The spend resolver once sent a bare scan while the balance read paid the
 * restore proof-of-work, so production refused every Grin send, tip and claim
 * with "this restore depth requires a 9-bit proof-of-work nonce". These pin the
 * shared helper's properties: a priced policy always yields a priced request, an
 * unpriceable one is never sent, and an unknown policy is reported as unknown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grinScanParams, loadGrinRestorePolicy, pricedGrinScan } from '../grin-restore-scan';
import { invalidateCapabilities } from '../api/capabilities-cache';
import { requiredRestorePowBits, solveRestorePow } from '../pow';

const PRICED = { pow_free_days: 90, pow_days_per_bit: 30, pow_max_bits: 24, max_depth_days: 365 };
const TIP = 3_500_000;
const RH = 'ab'.repeat(32);

type Params = { rewindHash: string; startHeight?: number; restorePowNonce?: number };

function fakeGrin(tip: number | null) {
  const sent: Params[] = [];
  return {
    sent,
    scan: async (p: Params) => {
      sent.push({ ...p });
      return { data: { outputs: [], total_balance: 0, last_pmmr_index: 0 }, status: 200 };
    },
    getHeight: async () =>
      tip === null ? { error: 'node unreachable', status: 502 } : { data: { height: tip }, status: 200 },
  };
}

test('a priced policy scans from the deepest permitted height and pays its price', async () => {
  const p = await grinScanParams(RH, TIP, PRICED);
  assert.ok(p && p.startHeight !== undefined);
  assert.ok(p.startHeight < TIP, 'a real depth, not the tip');
  const bits = requiredRestorePowBits('grin', p.startHeight, TIP, PRICED);
  assert.ok(bits > 0, 'this depth is priced');
  assert.equal(p.restorePowNonce, await solveRestorePow('grin', RH, p.startHeight, bits));
});

test('an unpriced or absent policy leaves the depth to the backend', async () => {
  for (const policy of [undefined, null, {}, { ...PRICED, pow_days_per_bit: 0 }]) {
    const p = await grinScanParams(RH, TIP, policy);
    assert.ok(p);
    assert.equal(p.startHeight, undefined);
    assert.equal(p.restorePowNonce, undefined);
  }
});

test('pricedGrinScan sends the priced params and returns the tip that priced them', async () => {
  const grin = fakeGrin(TIP);
  const r = await pricedGrinScan(grin as never, RH, PRICED);
  assert.equal(grin.sent.length, 1);
  assert.deepEqual(grin.sent[0], await grinScanParams(RH, TIP, PRICED));
  assert.equal(r.height.data?.height, TIP);
  assert.ok(r.scan.data, 'the scan result comes back');
});

test('pricedGrinScan never sends a priced scan it could not price', async () => {
  const grin = fakeGrin(null);
  const r = await pricedGrinScan(grin as never, RH, PRICED);
  assert.equal(grin.sent.length, 0, 'no bare scan for the backend to refuse');
  assert.ok(r.scan.error && !r.scan.data, 'the caller sees a scan error');
});

function capsApi(answers: Array<object | null>, baseUrl: string) {
  const probe = {
    calls: 0,
    getBaseUrl: () => baseUrl,
    getCapabilities: async () => {
      const a = answers[Math.min(probe.calls, answers.length - 1)];
      probe.calls++;
      return a ? { data: a as never } : {};
    },
  };
  return probe;
}

test('loadGrinRestorePolicy retries a cached failure once, then reports unknown', async () => {
  invalidateCapabilities();
  const flaky = capsApi([null, { restore: { policy: 'bounded', ...PRICED } }], 'https://flaky.test');
  assert.equal((await loadGrinRestorePolicy(flaky))?.pow_days_per_bit, PRICED.pow_days_per_bit);

  invalidateCapabilities();
  const down = capsApi([null], 'https://down.test');
  assert.equal(await loadGrinRestorePolicy(down), null);
  assert.ok(down.calls >= 2);
});

test('loadGrinRestorePolicy reads a backend without a restore block as unpriced', async () => {
  invalidateCapabilities();
  const old = capsApi([{ chains: {} }], 'https://old.test');
  const policy = await loadGrinRestorePolicy(old);
  assert.ok(policy, 'known, not unknown');
  const p = await grinScanParams(RH, TIP, policy);
  assert.equal(p?.restorePowNonce, undefined);
});
