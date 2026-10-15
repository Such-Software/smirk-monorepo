// The encoder must refuse footage that breaks the owner's video policy,
// including a screen that was never held (not only a hold that ran short), and
// must find every session a run left, so none is overwritten or forgotten:
//   node --test packages/e2e/scripts/F-legacy-recovery-encode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditTimeline, sessionsUnder } from './F-legacy-recovery-encode.mjs';

const POLICY = { tapPauseMs: 6_000, settledHoldMs: 12_000, resultHoldMs: 25_000, frameIntervalMs: 250, holdAfterEveryStep: true };

/** A tap at `at`: its still pause, the action, and the held screen after it. */
function tap(at, label = 'Open Settings') {
  return {
    step: { kind: 'tap', label, from: at, until: at + 6_100 },
    holds: [
      { kind: 'pre-tap', label, plannedMs: 6_000, from: at, until: at + 6_000 },
      { kind: 'settled', label, plannedMs: 12_000, from: at + 6_200, until: at + 18_200 },
    ],
  };
}

function timeline(parts, extra = {}) {
  return { policy: POLICY, pages: [], marks: [], steps: parts.map((p) => p.step), holds: parts.flatMap((p) => p.holds), ...extra };
}

test('a compliant timeline passes', () => {
  assert.deepEqual(auditTimeline(timeline([tap(0), tap(20_000)]), '/nonexistent'), []);
});

test('a screen that was never held is refused', () => {
  const first = tap(0);
  first.holds = first.holds.filter((h) => h.kind !== 'settled');
  const problems = auditTimeline(timeline([first, tap(7_000)]), '/nonexistent');
  assert.ok(problems.some((p) => /not held before the next step/.test(p)), problems.join('; '));
});

test('a step without its still pause is refused', () => {
  const first = tap(0);
  first.holds = first.holds.filter((h) => h.kind !== 'pre-tap');
  const problems = auditTimeline(timeline([first]), '/nonexistent');
  assert.ok(problems.some((p) => /no still pause/.test(p)), problems.join('; '));
});

test('a short hold, a weaker policy, a timeline without steps and a value-like label are refused', () => {
  const short = tap(0);
  short.holds[1].until = short.holds[1].from + 5_000;
  assert.ok(auditTimeline(timeline([short]), '/x').some((p) => /below the 12000 ms policy/.test(p)));
  assert.ok(auditTimeline(timeline([], { policy: { ...POLICY, settledHoldMs: 1_000 } }), '/x').some((p) => /settledHoldMs/.test(p)));
  assert.ok(auditTimeline({ policy: { ...POLICY, holdAfterEveryStep: undefined }, holds: [] }, '/x').some((p) => /every step/.test(p)));
  assert.ok(auditTimeline(timeline([], { marks: [{ label: 'https://smirk.cash/tip/x', at: 0 }] }), '/x').some((p) => /looks like a value/.test(p)));
});

/**
 * The Send receipt chain: "Send" with its pause and no hold after, an optional
 * redacted password step, then "Stay on this screen" at once and held.
 */
function countdownChain(at, { password = false } = {}) {
  const send = { step: { kind: 'tap', label: 'Send: broadcast', from: at, until: at + 6_100, urgent: 'countdown' },
    holds: [{ kind: 'pre-tap', label: 'Send: broadcast', plannedMs: 6_000, from: at, until: at + 6_000 }] };
  let t = at + 7_000;
  const parts = [send];
  if (password) {
    parts.push({ step: { kind: 'secret', label: 'Password confirmation (redacted)', from: t, until: t + 1_500, urgent: 'countdown' }, holds: [] });
    t += 2_000;
  }
  parts.push({ step: { kind: 'tap', label: 'Stay on the receipt', from: t, until: t + 100, urgent: 'countdown' },
    holds: [{ kind: 'settled', label: 'Stay on the receipt', plannedMs: 12_000, from: t + 200, until: t + 12_200 }] });
  return parts;
}

test('a self-closing receipt is reached and stopped without holds in between, and then held', () => {
  // 2026-10-15: a 12 s hold after "Send" outlasted the receipt's 12 s countdown.
  assert.deepEqual(auditTimeline(timeline([...countdownChain(0), tap(40_000)]), '/x'), []);
  assert.deepEqual(auditTimeline(timeline([...countdownChain(0, { password: true }), tap(40_000)]), '/x'), []);
});

test('the countdown exception is refused outside one short chain that ends held', () => {
  const unheldEnd = countdownChain(0);
  unheldEnd.at(-1).holds = [];
  assert.ok(auditTimeline(timeline([...unheldEnd, tap(40_000)]), '/x').some((p) => /not held/.test(p)), 'a chain must end on a held screen');

  const intoPlain = countdownChain(0).slice(0, 1);
  assert.ok(auditTimeline(timeline([...intoPlain, tap(10_000)]), '/x').some((p) => /not held/.test(p)), 'an unheld urgent step must lead to another urgent one');

  const loneStay = countdownChain(0).slice(1);
  assert.ok(auditTimeline(timeline([tap(-30_000), ...loneStay]), '/x').some((p) => /no still pause/.test(p)), 'only a chain continuation may skip its pause');

  const odd = countdownChain(0);
  odd[0].step.urgent = 'impatience';
  assert.ok(auditTimeline(timeline(odd), '/x').some((p) => /unknown urgency/.test(p)));

  const typed = countdownChain(0);
  typed[0].step.kind = 'enter';
  assert.ok(auditTimeline(timeline(typed), '/x').some((p) => /unknown urgency/.test(p)), 'only a tap or a redacted step may be urgent');

  const long = countdownChain(0, { password: true });
  const extra = { step: { kind: 'secret', label: 'Password confirmation (redacted)', from: 8_600, until: 8_800, urgent: 'countdown' }, holds: [] };
  long.splice(2, 0, extra);
  long.at(-1).step.from = 9_000;
  assert.ok(auditTimeline(timeline(long), '/x').some((p) => /chain longer/.test(p)), 'the chain is bounded');
});

test('every session of every wallet is found, oldest first, with the earlier layout too', () => {
  const raw = mkdtempSync(join(tmpdir(), 'f-legacy-sessions-'));
  try {
    for (const dir of ['alice/20261010T120000Z-w0-p1', 'alice/20261010T090000Z-w0-p1', 'bob/20261010T100000Z-w1-p2', 'carol']) {
      mkdirSync(join(raw, dir), { recursive: true });
      writeFileSync(join(raw, dir, 'timeline.json'), '{}');
    }
    mkdirSync(join(raw, 'alice', 'page-0'), { recursive: true });
    const names = sessionsUnder(raw).map((s) => s.name);
    assert.deepEqual(names, ['alice-20261010T090000Z-w0-p1', 'alice-20261010T120000Z-w0-p1', 'bob-20261010T100000Z-w1-p2', 'carol']);
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
});
