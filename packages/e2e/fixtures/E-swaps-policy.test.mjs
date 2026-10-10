// The E-swaps dead-air policy as the encoder enforces it.
// Run: node --test packages/e2e/fixtures/E-swaps-policy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_CLOSE_TAPS, HOLD, holdRefusals } from './E-swaps-policy.mjs';

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
    assert.notDeepEqual(holdRefusals(timeline([[kind, 'a screen', ms - 1]], false)), [], kind);
    assert.deepEqual(holdRefusals(timeline([[kind, 'a screen', ms], ...(kind === 'tap' || kind === 'type' ? [settled('after')] : [])])), [], kind);
  }
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
