/**
 * `dappPublicCacheFor` expiry stamping.
 *
 * What is locked in here: with auto-lock 0 (the DEFAULT) the cache entry
 * carries NO `sessionExpiresAtMs` at all. It used to be stamped with
 * `Date.now()`, which the SW's `readCache()` (background/dapp/provider.ts)
 * reads as already expired: it deleted the entry on the very next read, so
 * `window.smirk` reported LOCKED and `connect()` handed the page all-null keys
 * immediately after the user approved it.
 *
 * The complementary half is that a NON-zero auto-lock still stamps a real
 * expiry, because that is the case the staleness check exists for: the session
 * cache can outlive the popup, so the SW has to notice the timeout itself.
 */

import './_chrome-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AUTO_LOCK_MAX_MINUTES, type UnlockedWallet } from '@smirk/core';

import { dappPublicCacheFor } from '../dapp-public-cache';

function makeWallet(): UnlockedWallet {
  const cn = {
    privateSpendKey: new Uint8Array(32).fill(3),
    privateViewKey: new Uint8Array(32).fill(7),
    publicSpendKey: new Uint8Array(32).fill(1),
    publicViewKey: new Uint8Array(32).fill(9),
  };
  return {
    fingerprint: 'fp-test',
    // No `nostr` key and no mnemonic: the warm-restore shape. Keeps the
    // fixture off the bip39 derivation path; nostrPublicKey is simply absent.
    keys: {
      btc: { publicKey: new Uint8Array(33).fill(2) },
      ltc: { publicKey: new Uint8Array(33).fill(4) },
      xmr: cn,
      wow: cn,
      grin: { publicKey: new Uint8Array(32).fill(5) },
    },
    addresses: {
      btc: 'bc1qbtc',
      ltc: 'ltc1qltc',
      xmr: '4primary-xmr-address',
      wow: 'Wo-primary-wow-address',
      grin: 'grin1address',
    },
  } as unknown as UnlockedWallet;
}

test('auto-lock 0 (the default) writes no sessionExpiresAtMs', () => {
  const cache = dappPublicCacheFor(makeWallet(), 0);
  // `in`, not `=== undefined`: readCache() gates on
  // `typeof v.sessionExpiresAtMs === 'number'`, so the field must be missing
  // rather than present-and-stale.
  assert.equal('sessionExpiresAtMs' in cache, false);
  assert.equal(typeof cache.unlockedAt, 'number');
});

test('values that clamp to 0 also write no sessionExpiresAtMs', () => {
  for (const raw of [NaN, Infinity, 0]) {
    const cache = dappPublicCacheFor(makeWallet(), raw);
    assert.equal(
      'sessionExpiresAtMs' in cache,
      false,
      `expected no expiry for autoLockMinutes=${String(raw)}`,
    );
  }
});

test('a real auto-lock still stamps its expiry (staleness stays enforced)', () => {
  const before = Date.now();
  const cache = dappPublicCacheFor(makeWallet(), 15);
  const after = Date.now();
  assert.equal(typeof cache.sessionExpiresAtMs, 'number');
  assert.ok(cache.sessionExpiresAtMs! >= before + 15 * 60_000);
  assert.ok(cache.sessionExpiresAtMs! <= after + 15 * 60_000);
});

test('legacy negative "Never" clamps to the 24h cap, not to no-expiry', () => {
  const before = Date.now();
  const cache = dappPublicCacheFor(makeWallet(), -1);
  assert.equal(typeof cache.sessionExpiresAtMs, 'number');
  assert.ok(cache.sessionExpiresAtMs! >= before + AUTO_LOCK_MAX_MINUTES * 60_000);
});
