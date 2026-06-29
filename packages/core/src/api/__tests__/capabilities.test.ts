/**
 * The restore-policy interpretation must mirror the backend's enforcement so the
 * import UX and the server agree on what's allowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { earliestRestoreDate, type RestoreCapability } from '../capabilities';

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
