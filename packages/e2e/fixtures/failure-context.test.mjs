// The worker's side of the private failure log: a step label reaches the
// record only once both the lane's footage guard and the reporter's allowlist
// admit it. No browser: every footage helper refuses its label before it
// touches the page, so a stand-in page is never used.
// Run: node --import tsx --test packages/e2e/fixtures/failure-context.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteStep, privateContext } from './failure-context.ts';
import { GuardedFootage } from './guarded-footage.ts';
import { SecretCanary as BCanary, Timeline as BTimeline, WalletFootage as BFootage } from './B-send-receive-history-footage.ts';
import { GuardedFootage as CFootage } from './C-tips-footage.ts';
import { DFootage, SecretCanary as DCanary } from './D-messaging-federation-footage.ts';
import { WalletFootage as EFootage, WalletTimeline as ETimeline } from './E-swaps-footage.ts';
import { Canary as ECanary } from './E-swaps-guard.mjs';
import { GuardedFootage as GFootage } from './G-premium-footage.ts';
import { leaked, mixedToken, probes } from './leak-probes.mjs';

const BEFORE = 'Open the home tab';
const standIn = {};

async function lastStep() {
  const context = await privateContext({ errors: [{ message: 'x' }], status: 'failed', expectedStatus: 'passed' });
  return context.steps.at(-1)?.label;
}

/** Run `call`, which must refuse its label, and report the step the record would name. */
async function stepAfterRefusal(call) {
  noteStep(BEFORE);
  // A refusal, not a crash on the stand-in page: the label was checked first.
  await assert.rejects(call(), (error) => error instanceof Error && !(error instanceof TypeError));
  return lastStep();
}

test('a label is noted only when the reporter would keep it', async () => {
  for (const probe of probes()) {
    noteStep(`Confirm ${probe.value}`);
    const context = await privateContext({ errors: [{ message: 'x' }], status: 'failed', expectedStatus: 'passed' });
    assert.equal(context.steps.at(-1).label, 'label withheld', probe.name);
    assert.equal(leaked(JSON.stringify(context), probe.parts), false, `${probe.name} in the step ring`);
  }
});

test('a label the footage guard refuses is never noted as the running step, in every lane', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'smirk-footage-order-'));
  const saved = process.env.FOOTAGE;
  delete process.env.FOOTAGE;
  // A claim link every lane guard refuses, and a base64 value broken into short
  // runs by `/`, which guarded-footage refuses and the old reporter rule kept.
  const refused = [`Open https://smirk.cash/tip/x#k=${mixedToken(12)}`, `Send ${mixedToken(10)}/${mixedToken(10)}`];
  try {
    const guarded = new GuardedFootage({ mode: 'off', root, runId: 'order', worker: 0, scale: 1 });
    const lanes = {
      'guarded tap': (label) => guarded.tap(standIn, label),
      'guarded choose': (label) => guarded.choose(standIn, 'x', label),
      'guarded type': (label) => guarded.type(standIn, 'x', label),
      'guarded secretFill': (label) => guarded.secretFill(standIn, 'x', label),
      'guarded press': (label) => guarded.press(standIn, 'Enter', label),
      'guarded settled': (label) => guarded.settled(standIn, label),
      'guarded result': (label) => guarded.result(standIn, label),
      'B result': (label) => new BFootage('alice', standIn, new BCanary(), null, new BTimeline(null)).result(label),
      'C tap': (label) => new CFootage().tap(standIn, label),
      'C result': (label) => new CFootage().result(standIn, label),
      'D result': (label) => new DFootage('alice', standIn, { dir: null, canary: new DCanary(), guard: {}, shortHolds: true }).result(label),
      'E result': (label) => new EFootage(new ETimeline(join(root, 'e'), 'alice', 'order', false), new ECanary(), () => ({ page: standIn, recorder: standIn })).result(label),
      'G result': (label) => new GFootage({ recording: false }).result(standIn, label),
    };
    for (const [lane, call] of Object.entries(lanes)) {
      for (const label of refused) {
        if (lane.startsWith('guarded') || label.includes('://')) {
          await t.test(`${lane}, ${label.includes('://') ? 'claim link' : 'split base64'}`, async () => {
            assert.equal(await stepAfterRefusal(() => call(label)), BEFORE, 'the step before the refused one');
          });
        }
      }
    }
  } finally {
    if (saved === undefined) delete process.env.FOOTAGE;
    else process.env.FOOTAGE = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
