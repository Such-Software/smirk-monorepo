// The E-swaps dead-air policy as the encoder enforces it.
// Run: node --test packages/e2e/fixtures/E-swaps-policy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_CLOSE_TAPS, HOLD, holdRefusals } from './E-swaps-policy.mjs';
import { HOLD_TOLERANCE_MS } from './hold-timer.mjs';

/** Consecutive holds, 100 ms apart, as [kind, label, ms, extra?]. */
function timeline(specs, closed = true) {
  let clock = 0;
  const holds = specs.map(([kind, label, ms, extra = {}]) => {
    const h = { kind, label, from: clock, until: clock + ms, requiredMs: ms, ...extra };
    clock = h.until + 100;
    return h;
  });
  return { holds, stoppedAt: closed ? clock : null };
}

const tap = (label, extra) => ['tap', label, HOLD.preTapMs, extra];
const settled = (label) => ['settled', label, HOLD.settledMs];
const result = (label) => ['result', label, HOLD.resultMs];

test('taps, typed fields, settled screens and results in policy are admitted', () => {
  const t = timeline([
    settled('wallet ready on Home'),
    tap('open the Swap tab'),
    settled('Swap tab'),
    ['type', 'type the amount to swap', HOLD.preTapMs],
    result('THORChain quote'),
  ]);
  assert.deepEqual(holdRefusals(t), []);
});

test('a hold shorter than its policy is refused, whatever its kind', () => {
  for (const [kind, ms] of [['tap', HOLD.preTapMs], ['type', HOLD.preTapMs], ['settled', HOLD.settledMs], ['result', HOLD.resultMs]]) {
    // Asked for the full policy, measured short by more than a timer tick.
    assert.notDeepEqual(holdRefusals(timeline([[kind, 'a screen', ms - HOLD_TOLERANCE_MS - 1, { requiredMs: ms }]], false)), [], kind);
    assert.deepEqual(holdRefusals(timeline([[kind, 'a screen', ms], ...(kind === 'tap' || kind === 'type' ? [settled('after')] : [])])), [], kind);
  }
});

test('a hold a timer tick short of its policy is admitted, but never a weaker policy', () => {
  // The run that found this: a 5999 ms tap hold and an 11999 ms settle, each
  // a correct sleep that the event loop's clock woke a millisecond early.
  const ticks = timeline([
    ['tap', 'open the Swap tab', HOLD.preTapMs - 1, { requiredMs: HOLD.preTapMs }],
    ['settled', 'Swap tab', HOLD.settledMs - 1, { requiredMs: HOLD.settledMs }],
  ]);
  assert.deepEqual(holdRefusals(ticks), []);
  const weaker = timeline([['tap', 'open the Swap tab', HOLD.preTapMs], settled('Swap tab')]);
  weaker.holds[0].requiredMs = HOLD.preTapMs - 1;
  assert.notDeepEqual(holdRefusals(weaker), []);
});

test('a screen reached by an action and never held settled is refused', () => {
  // Between two taps.
  assert.notDeepEqual(holdRefusals(timeline([tap('open the Home tab'), tap('Home tab root'), settled('Home')])), []);
  // After the last tap of a closed timeline, but not of one cut short.
  const unheldEnd = [tap('open the Home tab'), settled('Home'), tap('close the swap wizard')];
  assert.notDeepEqual(holdRefusals(timeline(unheldEnd, true)), []);
  assert.deepEqual(holdRefusals(timeline(unheldEnd, false)), []);
});

test('only a reviewed auto-close tap may skip the settle, and the screen it keeps is still held', () => {
  const [allowed] = AUTO_CLOSE_TAPS;
  assert.ok(allowed, 'the reviewed list names the Send done screen');
  const kept = [tap('send the deposit'), tap(allowed, { beforeAutoClose: true }), result('deposit broadcast'), tap('close the send'), settled('Home')];
  assert.deepEqual(holdRefusals(timeline(kept)), []);
  // Any other label claiming the exception is refused.
  const claimed = [tap('send the deposit'), tap('close the send', { beforeAutoClose: true }), settled('Home')];
  assert.notDeepEqual(holdRefusals(timeline(claimed)), []);
  // The kept screen still needs its hold before the next tap.
  const unheld = [tap('send the deposit'), tap(allowed, { beforeAutoClose: true }), tap('close the send'), settled('Home')];
  assert.notDeepEqual(holdRefusals(timeline(unheld)), []);
});
