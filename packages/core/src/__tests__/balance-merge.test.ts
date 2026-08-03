/**
 * mergeBalancesKeepLastKnown: the "don't flash to 0 on a failed fetch" logic.
 * A transient LWS/electrum failure returns a zeroed `{error}` balance; merging it
 * over a good last-known value must keep the number (flagged stale), which is the
 * fix for the reported "XMR/WOW showed then disappeared" jank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeBalancesKeepLastKnown, type Balances } from '../wallet-flow';

const bal = (confirmed: bigint, extra: Partial<Balances['btc']> = {}) => ({
  confirmed,
  pending: 0n,
  ...extra,
});

function base(overrides: Partial<Record<keyof Balances, Balances['btc']>> = {}): Balances {
  return {
    btc: bal(1n),
    ltc: bal(2n),
    xmr: bal(3n),
    wow: bal(4n),
    grin: bal(5n),
    ...overrides,
  } as Balances;
}

test('errored fresh value keeps last-known and marks it stale', () => {
  const prev = base();
  const fresh = base({ xmr: bal(0n, { error: 'LWS 400' }) });
  const merged = mergeBalancesKeepLastKnown(prev, fresh);
  assert.equal(merged.xmr.confirmed, 3n, 'kept last-known XMR, not the errored 0');
  assert.equal(merged.xmr.stale, true, 'flagged stale');
  // Clean assets take the fresh value and are NOT stale.
  assert.equal(merged.btc.confirmed, 1n);
  assert.equal(merged.btc.stale, undefined);
});

test('clean fresh value replaces last-known (and clears any prior stale)', () => {
  const prev = base({ xmr: bal(3n, { stale: true }) });
  const fresh = base({ xmr: bal(9n) });
  const merged = mergeBalancesKeepLastKnown(prev, fresh);
  assert.equal(merged.xmr.confirmed, 9n);
  assert.equal(merged.xmr.stale, undefined, 'fresh clean value is not stale');
});

test('no prior (cold start) returns the fresh set as-is, errors and all', () => {
  const fresh = base({ wow: bal(0n, { error: 'down' }) });
  const merged = mergeBalancesKeepLastKnown(null, fresh);
  assert.equal(merged.wow.confirmed, 0n);
  assert.equal(merged.wow.error, 'down');
  assert.equal(merged.wow.stale, undefined, 'nothing better to fall back to → not stale');
});

test('both prior and fresh errored → keep the fresh errored value', () => {
  const prev = base({ ltc: bal(0n, { error: 'old' }) });
  const fresh = base({ ltc: bal(0n, { error: 'new' }) });
  const merged = mergeBalancesKeepLastKnown(prev, fresh);
  assert.equal(merged.ltc.error, 'new');
});
