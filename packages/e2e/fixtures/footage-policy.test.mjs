// The dead-air check must pass a timeline that held every screen and paused
// before every tap, and must catch each way a recording can fall short: a tap
// on a screen that just changed, a screen left without its settled hold, and a
// hold that ended while the screen was still changing.
//   node --test packages/e2e/fixtures/footage-policy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_MS, checkHoldPolicy, describeViolations } from './footage-policy.mjs';

const R = 'alice-1';
const S = 1_000;

/** A page that appears, settles, pauses, is tapped, shows a result, pauses and is tapped again. */
function compliant() {
  const entries = [{ kind: 'recorder', t: 0, recorder: R }, { kind: 'frame', t: 200, recorder: R }];
  let t = 200 + HOLD_MS.settled;
  entries.push({ kind: 'hold', t: 200, end: t, hold: 'settled', label: 'welcome', recorder: R });
  entries.push({ kind: 'hold', t, end: t + HOLD_MS.preTap, hold: 'preTap', label: 'tap one', recorder: R });
  t += HOLD_MS.preTap;
  entries.push({ kind: 'tap', t, label: 'tap one', recorder: R });
  const next = t + 300;
  entries.push({ kind: 'frame', t: next, recorder: R });
  t = next + HOLD_MS.result;
  entries.push({ kind: 'hold', t: next, end: t, hold: 'result', label: 'result', recorder: R });
  entries.push({ kind: 'hold', t, end: t + HOLD_MS.preTap, hold: 'preTap', label: 'tap two', recorder: R });
  t += HOLD_MS.preTap;
  entries.push({ kind: 'tap', t, label: 'tap two', recorder: R });
  return entries;
}

test('a timeline that held every screen and paused before every tap passes', () => {
  const report = checkHoldPolicy(compliant());
  assert.deepEqual(report.violations, []);
  assert.ok(report.taps > 0 && report.holds > 0, 'the check looked at nothing');
});

test('a tap on a screen that changed just before it is caught', () => {
  const entries = compliant();
  const lastTap = entries.findLast((entry) => entry.kind === 'tap');
  entries.push({ kind: 'frame', t: lastTap.t - 2 * S, recorder: R });
  const rules = checkHoldPolicy(entries).violations.map((violation) => violation.rule);
  assert.ok(rules.includes('tap without a static pause'));
  assert.ok(rules.includes('screen left without a settled hold'), 'the changed frame was never settled either');
});

test('a screen left with only the pre-tap pause is caught', () => {
  const entries = [
    { kind: 'recorder', t: 0, recorder: R },
    { kind: 'frame', t: 100, recorder: R },
    { kind: 'hold', t: 100, end: 100 + HOLD_MS.preTap, hold: 'preTap', label: 'quick tap', recorder: R },
    { kind: 'tap', t: 100 + HOLD_MS.preTap, label: 'quick tap', recorder: R },
  ];
  const report = checkHoldPolicy(entries);
  assert.deepEqual(report.violations.map((violation) => violation.rule), ['screen left without a settled hold']);
});

test('a settled hold of an earlier frame does not cover a later one', () => {
  const entries = compliant();
  // The result frame changes once more after its hold; the tap follows a pause only.
  const resultHold = entries.find((entry) => entry.kind === 'hold' && entry.hold === 'result');
  const tap = entries.findLast((entry) => entry.kind === 'tap');
  entries.push({ kind: 'frame', t: resultHold.end + 100, recorder: R });
  tap.t = resultHold.end + 100 + HOLD_MS.preTap + 50;
  const rules = checkHoldPolicy(entries).violations.map((violation) => violation.rule);
  assert.ok(rules.includes('screen left without a settled hold'));
  assert.ok(!rules.includes('tap without a static pause'), 'the pause itself was long enough');
});

test('a hold that ends while the screen is still changing is caught', () => {
  const entries = compliant();
  const hold = entries.find((entry) => entry.kind === 'hold' && entry.hold === 'settled');
  entries.push({ kind: 'frame', t: hold.end - 3 * S, recorder: R });
  const rules = checkHoldPolicy(entries).violations.map((violation) => violation.rule);
  assert.ok(rules.includes('hold ended on a changing screen'));
});

test('cards count as changes, and a static card satisfies the holds', () => {
  const entries = [
    { kind: 'recorder', t: 0, recorder: R },
    { kind: 'card', t: 50, recorder: R },
    { kind: 'hold', t: 50, end: 50 + HOLD_MS.settled, hold: 'settled', label: 'card settled', recorder: R },
    { kind: 'tap', t: 50 + HOLD_MS.settled + HOLD_MS.preTap, label: 'unlock', recorder: R },
  ];
  assert.deepEqual(checkHoldPolicy(entries).violations, []);
  entries.push({ kind: 'card', t: entries[3].t - S, recorder: R });
  assert.ok(checkHoldPolicy(entries).violations.length > 0, 'a new card just before the tap went unnoticed');
});

test('holds on a page that closed before they ended, and taps on unrecorded pages, are not judged', () => {
  const entries = [
    { kind: 'recorder', t: 0, recorder: R },
    { kind: 'frame', t: 100, recorder: R },
    { kind: 'stop', t: 2 * S, recorder: R },
    { kind: 'hold', t: 100, end: 5 * S, hold: 'settled', label: 'closed mid hold', recorder: R },
    { kind: 'tap', t: 6 * S, label: 'unrecorded', recorder: null },
    { kind: 'hold', t: 0, end: S, hold: 'preTap', label: 'unrecorded', recorder: null },
  ];
  assert.deepEqual(checkHoldPolicy(entries).violations, []);
});

test('the description is one line naming each case', () => {
  const entries = compliant();
  entries.push({ kind: 'frame', t: entries.findLast((entry) => entry.kind === 'tap').t - S, recorder: R });
  const { violations } = checkHoldPolicy(entries);
  const line = describeViolations(violations);
  assert.ok(!line.includes('\n'));
  assert.ok(line.includes(R) && line.includes('tap two'));
});
