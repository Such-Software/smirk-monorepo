import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tipTimeline } from '../TipDetailSheet';

const at = (status: string, confs = 0, required = 2) =>
  tipTimeline({ status, fundingConfirmations: confs, confirmationsRequired: required });

test('timeline: waiting on the chain, then on the recipient', () => {
  const confirming = at('pending_confirmation', 1, 2);
  assert.equal(confirming.find((s) => s.label === 'Confirmed')?.state, 'current');
  assert.equal(confirming.find((s) => s.label === 'Claimed')?.state, 'todo');

  const claimable = at('pending', 2, 2);
  assert.equal(claimable.find((s) => s.label === 'Confirmed')?.state, 'done');
  assert.equal(claimable.find((s) => s.label === 'Claimed')?.state, 'current');
});

test('timeline: terminal states end in done or failed, never current', () => {
  for (const status of ['claimed', 'clawed_back', 'cancelled']) {
    const steps = at(status, 2, 2);
    assert.ok(steps.every((s) => s.state !== 'current'), `${status} has no current step`);
  }
  assert.ok(at('clawed_back').some((s) => s.label === 'Reclaimed' && s.state === 'done'));
  assert.ok(at('cancelled').some((s) => s.state === 'failed'));
  assert.ok(at('funding_mismatch').some((s) => s.state === 'failed'));
});

test('timeline: confirmations shown never exceed the requirement', () => {
  const steps = at('pending', 9, 2);
  assert.equal(steps.find((s) => s.label === 'Confirmed')?.detail, '2/2');
});
