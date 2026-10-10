// The E-swaps encoder's admission rules (no ffmpeg needed).
// Run: node --test packages/e2e/scripts/E-swaps-encode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refusals, runEvidence, selectRun, storyboard } from './E-swaps-encode.mjs';
import { HOLD } from '../fixtures/E-swaps-policy.mjs';

function area(runs) {
  const dir = mkdtempSync(join(tmpdir(), 'e-swaps-encode-'));
  for (const [id, evidence] of runs) {
    mkdirSync(join(dir, `run-${id}`));
    if (evidence) writeFileSync(join(dir, `run-${id}`, 'evidence.json'), JSON.stringify(evidence));
  }
  return dir;
}

const proved = (runId) => ({ runId, backend: 'x', build: { manifestName: 'Smirk Wallet', manifestVersion: '0.3.1', zip: { file: 'z.zip', sha256: 'e6'.repeat(32), entries: 3, matchesDist: true } } });

test('a run is encoded only when named, or when the newest is asked for', () => {
  const dir = area([['1700000000000', proved('1700000000000')], ['1800000000000', proved('1800000000000')]]);
  try {
    assert.throws(() => selectRun(dir, {}), undefined, 'no implicit choice');
    assert.equal(selectRun(dir, { latest: true }).id, '1800000000000');
    assert.equal(selectRun(dir, { run: '1700000000000' }).id, '1700000000000');
    assert.throws(() => selectRun(dir, { run: '1900000000000' }));
    assert.throws(() => selectRun(dir, { run: '1700000000000', latest: true }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run's evidence must be its own and must prove the build against a release zip", () => {
  const dir = area([['1', proved('1')], ['2', proved('3')], ['4', { runId: '4', build: { zip: null } }], ['5', null]]);
  try {
    assert.equal(runEvidence(join(dir, 'run-1'), '1').build.manifestVersion, '0.3.1');
    assert.throws(() => runEvidence(join(dir, 'run-2'), '2'), undefined, 'another run');
    assert.throws(() => runEvidence(join(dir, 'run-4'), '4'), undefined, 'build not proved');
    assert.throws(() => runEvidence(join(dir, 'run-5'), '5'), undefined, 'no evidence');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const base = (extra = {}) => ({
  version: 1,
  area: 'E-swaps',
  runId: '1',
  stoppedAt: 100_000,
  frames: [{ file: 'f.jpg', role: 'main', from: 0, until: 100_000, verdict: 'clean', masked: [] }],
  holds: [{ kind: 'settled', label: 'wallet ready on Home', from: 0, until: HOLD.settledMs, requiredMs: HOLD.settledMs }],
  segments: [],
  markers: [],
  ...extra,
});

test('a timeline is admitted only for its own run, with verdicts, policy holds and static labels', () => {
  assert.deepEqual(refusals(base(), null, '1'), []);
  assert.notDeepEqual(refusals(base(), null, '2'), [], 'another run');
  assert.notDeepEqual(refusals(base({ frames: [{ file: 'f.jpg', from: 0, until: 1, verdict: 'unchecked' }] }), null, '1'), []);
  // A tap whose screen was never held settled (the policy module's rule).
  const unheld = base({ holds: [{ kind: 'tap', label: 'open the Swap tab', from: 0, until: HOLD.preTapMs, requiredMs: HOLD.preTapMs }] });
  assert.notDeepEqual(refusals(unheld, null, '1'), []);
  const valueLabel = base({ markers: [{ label: 'txid 0123456789abcdef', at: 1 }] });
  assert.notDeepEqual(refusals(valueLabel, null, '1'), []);
});

test('secret scopes cover the frames under them, and the screen after is shown again', () => {
  const t = base({
    frames: [
      { file: 'a.jpg', from: 0, until: 9_000, verdict: 'clean' },
      { file: 'b.jpg', from: 10_000, until: 30_000, verdict: 'clean' },
    ],
    segments: [{ kind: 'secret', label: 'operation password', from: 5_000, until: 15_000 }],
  });
  const board = storyboard(t, (label) => `card:${label}`);
  const at = (ms) => board.filter((e) => e.at <= ms).at(-1)?.image;
  assert.ok(at(1_000)?.frame);
  assert.ok(at(12_000)?.card, 'the redaction covers its interval');
  assert.ok(board.every((e) => !(e.image.frame && e.at > 5_000 && e.at < 15_000)), 'no frame inside the scope');
  assert.ok(at(20_000)?.frame, 'the screen after the scope comes back');
});
