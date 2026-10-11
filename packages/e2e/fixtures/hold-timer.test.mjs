// The shared hold timer: recorders never write a short hold, and encoders
// admit a measured hold only within the timer tolerance.
// Run: node --test packages/e2e/fixtures/hold-timer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_TOLERANCE_MS, heldLongEnough, sleepAtLeast } from './hold-timer.mjs';

test('a hold within the timer tolerance counts, and one short by more does not', () => {
  for (const policy of [6_000, 12_000, 25_000]) {
    assert.equal(heldLongEnough(policy, policy), true);
    assert.equal(heldLongEnough(policy - 1, policy), true, 'a timer tick short');
    assert.equal(heldLongEnough(policy - HOLD_TOLERANCE_MS, policy), true);
    assert.equal(heldLongEnough(policy - HOLD_TOLERANCE_MS - 1, policy), false);
    assert.equal(heldLongEnough(policy / 2, policy), false);
  }
  // Under one capture interval (about 250 ms), so no frame of the still is lost.
  assert.ok(HOLD_TOLERANCE_MS > 0 && HOLD_TOLERANCE_MS < 250);
  for (const missing of [undefined, null, Number.NaN, '6000']) {
    assert.equal(heldLongEnough(missing, 6_000), false, `a hold of ${String(missing)} is not a hold`);
  }
});

/** A fake clock: `wake(ms)` is how far the wall clock moves while the timer waits `ms`. */
function fakeClock(wake) {
  const state = { wall: 1_000, mono: 0, waits: [] };
  const clock = {
    now: () => state.wall,
    mono: () => state.mono,
    wait: async (ms) => {
      state.waits.push(ms);
      state.mono += ms;
      state.wall += wake(ms);
    },
  };
  return { state, clock };
}

test('sleepAtLeast keeps sleeping when the timer fires early', async () => {
  // The event loop's cached clock: the timer wakes a millisecond before the wall clock says.
  const early = fakeClock((ms) => Math.max(1, ms - 1));
  const measured = await sleepAtLeast(6_000, early.clock);
  assert.ok(measured >= 6_000, `measured ${measured} ms`);
  assert.ok(early.state.waits.length > 1, 'it slept again after the early wake-up');
  // A timer that is on time needs one wait.
  const exact = fakeClock((ms) => ms);
  assert.equal(await sleepAtLeast(12_000, exact.clock), 12_000);
  assert.equal(exact.state.waits.length, 1);
  // A wall clock stepped back an hour stretches the hold by about a second, not an hour.
  const stepped = fakeClock((ms) => (ms === 25_000 ? 25_000 - 3_600_000 : ms));
  await sleepAtLeast(25_000, stepped.clock);
  assert.ok(stepped.state.mono <= 25_000 + 1_000 + 25_000, `bounded by monotonic time (${stepped.state.mono} ms)`);
  // A real sleep is never short on the wall clock.
  const from = Date.now();
  await sleepAtLeast(30);
  assert.ok(Date.now() - from >= 30);
});
