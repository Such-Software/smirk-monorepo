/**
 * The B lane encoder's policy checks, on synthetic timelines (no frames, no
 * ffmpeg):
 *
 *   node --test packages/e2e/scripts/B-send-receive-history-footage.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movingHolds, verify } from './B-send-receive-history-footage.mjs';

const policy = { holdBeforeTapMs: 6_000, holdSettledMs: 12_000, holdResultMs: 25_000 };

function recorder(timeline, rows = []) {
  let at = 1_000_000;
  return {
    name: 'alice',
    rows,
    timeline: timeline.map(([kind, extra = {}]) => {
      at += 1_000;
      return { at, kind, label: `Step ${kind}`, ...extra };
    }),
  };
}

const settled = ['settled', { holdMs: 12_000 }];
const result = ['result', { holdMs: 25_000 }];
const tap = ['tap', { holdMs: 6_000 }];
const fill = ['fill', { holdMs: 6_000 }];

test('a held screen before every tap and entry passes', () => {
  const r = recorder([['session'], settled, tap, settled, fill, settled, tap, result, tap]);
  assert.deepEqual(verify('/nonexistent', [r], policy), []);
});

test('a tap on a screen that was never held is refused', () => {
  const problems = verify('/nonexistent', [recorder([['session'], settled, tap, tap])], policy);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /never held/);
});

test('the first tap of a session needs a hold too, and a secret scope resets it', () => {
  assert.equal(verify('/nonexistent', [recorder([['session'], tap])], policy).length, 1);
  const afterSecret = recorder([['session'], settled, ['secret-start'], ['secret-end'], tap]);
  assert.equal(verify('/nonexistent', [afterSecret], policy).length, 1);
  const restarted = recorder([['session'], settled, tap, ['session'], tap]);
  assert.equal(verify('/nonexistent', [restarted], policy).length, 1);
});

test('a poll wait is not a hold of the screen', () => {
  const r = recorder([['session'], settled, tap, ['hold', { holdMs: 90_000 }], tap]);
  assert.equal(verify('/nonexistent', [r], policy).length, 1);
});

test('short holds are refused', () => {
  const r = recorder([['session'], ['settled', { holdMs: 3_000 }], ['tap', { holdMs: 1_000 }], ['result', { holdMs: 10_000 }]]);
  assert.equal(verify('/nonexistent', [r], policy).length, 3);
});

test('an urgent countdown tap passes only when a settled hold follows it', () => {
  const ok = recorder([['session'], settled, tap, ['tap', { holdMs: 0, urgent: 'countdown' }], settled, result, tap]);
  assert.deepEqual(verify('/nonexistent', [ok], policy), []);
  const noHold = recorder([['session'], settled, ['tap', { holdMs: 0, urgent: 'countdown' }], result, tap]);
  assert.ok(verify('/nonexistent', [noHold], policy).some((p) => /not followed by a settled hold/.test(p)));
  const atEnd = recorder([['session'], settled, ['tap', { holdMs: 0, urgent: 'countdown' }]]);
  assert.ok(verify('/nonexistent', [atEnd], policy).some((p) => /not followed by a settled hold/.test(p)));
});

test('an urgency other than a countdown is refused', () => {
  const r = recorder([['session'], settled, ['tap', { holdMs: 0, urgent: 'hurry' }], settled]);
  assert.ok(verify('/nonexistent', [r], policy).some((p) => /unknown urgency/.test(p)));
  const urgentFill = recorder([['session'], settled, ['fill', { holdMs: 0, urgent: 'countdown' }], settled]);
  assert.ok(verify('/nonexistent', [urgentFill], policy).some((p) => /unknown urgency/.test(p)));
});

test('a timeline label that is not static text is refused', () => {
  const r = recorder([['session'], settled]);
  r.timeline[1].label = 'https://example.com/tx/abc';
  assert.ok(verify('/nonexistent', [r], policy).some((p) => /not static text/.test(p)));
});

test('holds whose screen still changed are reported', () => {
  const r = recorder([['session'], settled, tap]);
  const end = r.timeline[1].at;
  r.rows = [
    { at: end - 11_800, kind: 'frame', file: 'a.jpg', verdict: 'clean' },
    { at: end - 5_000, kind: 'frame', file: 'b.jpg', verdict: 'clean' },
  ];
  const moving = movingHolds([r]);
  assert.equal(moving.length, 1);
  assert.equal(moving[0].changes, 1);
});
