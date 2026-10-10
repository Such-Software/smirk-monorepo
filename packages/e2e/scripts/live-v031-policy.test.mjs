/**
 * One video policy for every live lane. Each area's recorder keeps its own
 * hold constants; this checks that none of them falls below the owner's
 * policy for the v0.3.1 release run: a still screen of at least 6 s before
 * every tap, 12 s on every settled screen and 25 s on every key result.
 * Longer holds are allowed (the owner asked for lots of dead air).
 *
 *   node --import tsx --test scripts/live-v031-policy.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOLD_MS as A } from '../fixtures/footage-policy.mjs';
import * as B from '../fixtures/B-send-receive-history-footage.ts';
import { OWNER_POLICY as C } from '../fixtures/C-tips-run.mjs';
import { D_HOLD as D } from '../fixtures/D-messaging-federation-footage.ts';
import { HOLD as E } from '../fixtures/E-swaps-policy.mjs';
import * as F from '../fixtures/F-legacy-recovery-footage.ts';
import * as G from '../fixtures/G-premium-footage.ts';
import { MIN_HOLD_MS as G_ENCODER } from './G-premium-footage.mjs';
import { HOLDS as H } from '../fixtures/H-cross-browser-desktop-policy.mjs';

const OWNER = Object.freeze({ preTap: 6_000, settled: 12_000, result: 25_000 });

const LANES = {
  'A onboarding and identity': { preTap: A.preTap, settled: A.settled, result: A.result },
  'B sends and history': { preTap: B.HOLD_BEFORE_TAP_MS, settled: B.HOLD_SETTLED_MS, result: B.HOLD_RESULT_MS },
  'C tips': { preTap: C.tap, settled: C.settled, result: C.result },
  'D messaging': { preTap: D.BEFORE_TAP_MS, settled: D.SETTLED_MS, result: D.RESULT_MS },
  'E swaps': { preTap: E.preTapMs, settled: E.settledMs, result: E.resultMs },
  'F legacy recovery': { preTap: F.TAP_PAUSE_MS, settled: F.SETTLED_HOLD_MS, result: F.RESULT_HOLD_MS },
  'G premium recorder': { preTap: G.TAP_PAUSE_MS, settled: G.SETTLED_HOLD_MS, result: G.RESULT_HOLD_MS },
  'G premium encoder': { preTap: G_ENCODER.tap, settled: G_ENCODER.settled, result: G_ENCODER.result },
  'H cross-browser': { preTap: H.preTapMs, settled: H.settledMs, result: H.resultMs },
};

test('every live lane holds at least the owner policy before taps, on settled screens and on key results', () => {
  for (const [lane, holds] of Object.entries(LANES)) {
    for (const kind of Object.keys(OWNER)) {
      assert.equal(typeof holds[kind], 'number', `${lane} declares a ${kind} hold`);
      assert.ok(holds[kind] >= OWNER[kind], `${lane}: the ${kind} hold is at least the owner's ${OWNER[kind] / 1000} s`);
    }
    assert.ok(holds.preTap < holds.settled && holds.settled < holds.result, `${lane}: key results are held longest`);
  }
});
