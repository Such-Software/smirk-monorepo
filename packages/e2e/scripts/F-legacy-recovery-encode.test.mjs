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
