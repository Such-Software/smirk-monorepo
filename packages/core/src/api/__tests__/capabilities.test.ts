/**
 * The restore-policy interpretation must mirror the backend's enforcement so the
 * import UX and the server agree on what's allowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  earliestRestoreDate,
  summarizeRegistration,
  type RestoreCapability,
} from '../capabilities';

const NOW = new Date('2026-06-28T00:00:00Z');

test('unlimited restore has no floor', () => {
  const r: RestoreCapability = { policy: 'unlimited', max_depth_days: null };
  assert.equal(earliestRestoreDate(r, NOW), null);
});

test('create-only floors at now (today only)', () => {
  const r: RestoreCapability = { policy: 'create-only', max_depth_days: null };
  assert.equal(earliestRestoreDate(r, NOW)?.getTime(), NOW.getTime());
});

test('bounded floors at now minus max_depth_days', () => {
  const r: RestoreCapability = { policy: 'bounded', max_depth_days: 30 };
  const got = earliestRestoreDate(r, NOW);
  assert.ok(got);
  assert.equal(got.getTime(), NOW.getTime() - 30 * 86_400_000);
});

test('bounded with null depth treats as zero (now)', () => {
  const r: RestoreCapability = { policy: 'bounded', max_depth_days: null };
  const got = earliestRestoreDate(r, NOW);
  assert.ok(got);
  assert.equal(got.getTime(), NOW.getTime());
});

test('summarizeRegistration — absent registration reads as fully open', () => {
  const s = summarizeRegistration(undefined);
  assert.deepEqual(s, { open: true, invite: false, pow: false, payment: false });
});

test('summarizeRegistration — PoW-only is still open (no user prompt needed)', () => {
  const s = summarizeRegistration({
    invite_required: false,
    pow_required: true,
    payment_required: false,
  });
  assert.equal(s.open, true);
  assert.equal(s.pow, true);
});

test('summarizeRegistration — invite gate is not open', () => {
  const s = summarizeRegistration({
    invite_required: true,
    pow_required: true,
    payment_required: false,
  });
  assert.equal(s.open, false);
  assert.equal(s.invite, true);
  assert.equal(s.price, undefined);
});

test('summarizeRegistration — payment gate surfaces a formatted price', () => {
  const s = summarizeRegistration({
    invite_required: false,
    pow_required: true,
    payment_required: true,
    payment_amount: '0.0001',
    payment_currency: 'BTC',
  });
  assert.equal(s.open, false);
  assert.equal(s.payment, true);
  assert.equal(s.price, '0.0001 BTC');
});

test('summarizeRegistration — payment_required but amount missing omits price', () => {
  const s = summarizeRegistration({
    invite_required: false,
    pow_required: false,
    payment_required: true,
  });
  assert.equal(s.payment, true);
  assert.equal(s.price, undefined);
});
