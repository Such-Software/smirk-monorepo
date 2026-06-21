/**
 * Tests for the 2026-06-13 wrapped-key session-cache hardening.
 *
 * Audit finding: keystore.ts header used to claim mnemonics were
 * never persisted, but the session-cache flow wrote them to
 * chrome.storage.session via the SessionCacheEntry shape. The fix
 * dropped the mnemonic from the cache shape entirely (Approach B —
 * see workflow rationale at docs/SECURITY_LOG.md 2026-06-13). These
 * tests pin the resulting behaviour so a future commit can't
 * accidentally re-introduce the plaintext mnemonic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_LOCK_MAX_MINUTES,
  clampAutoLockMinutes,
  parseSessionCache,
  restoreUnlockedFromCache,
  type SessionCachePayload,
  type UnlockedWallet,
} from '../keystore';

// --- clampAutoLockMinutes ----------------------------------------

test('clampAutoLockMinutes: rejects negative values to the cap (legacy -1 = "Never" → 24h)', () => {
  // Pre-2026-06-13 v0.2.4 wrote -1 to mean "Never (until browser
  // closes)". After this fix that sentinel self-heals to the cap
  // — no migration script needed.
  assert.equal(clampAutoLockMinutes(-1), AUTO_LOCK_MAX_MINUTES);
  assert.equal(clampAutoLockMinutes(-100), AUTO_LOCK_MAX_MINUTES);
});

test('clampAutoLockMinutes: clamps values over the cap', () => {
  assert.equal(clampAutoLockMinutes(Number.MAX_SAFE_INTEGER), AUTO_LOCK_MAX_MINUTES);
  assert.equal(clampAutoLockMinutes(AUTO_LOCK_MAX_MINUTES + 1), AUTO_LOCK_MAX_MINUTES);
  assert.equal(clampAutoLockMinutes(99_999), AUTO_LOCK_MAX_MINUTES);
});

test('clampAutoLockMinutes: passes through in-band values unchanged', () => {
  assert.equal(clampAutoLockMinutes(0), 0);
  assert.equal(clampAutoLockMinutes(10), 10);
  assert.equal(clampAutoLockMinutes(60), 60);
  assert.equal(clampAutoLockMinutes(AUTO_LOCK_MAX_MINUTES), AUTO_LOCK_MAX_MINUTES);
});

test('clampAutoLockMinutes: NaN / Infinity / non-number → 0 (no cache)', () => {
  assert.equal(clampAutoLockMinutes(NaN), 0);
  assert.equal(clampAutoLockMinutes(Infinity), 0);
  assert.equal(clampAutoLockMinutes(-Infinity), 0);
  assert.equal(clampAutoLockMinutes('60'), 0);
  assert.equal(clampAutoLockMinutes(undefined), 0);
  assert.equal(clampAutoLockMinutes(null), 0);
});

test('clampAutoLockMinutes: floors fractional inputs', () => {
  assert.equal(clampAutoLockMinutes(10.7), 10);
  assert.equal(clampAutoLockMinutes(60.999), 60);
});

// --- parseSessionCache -------------------------------------------

function makePayload(): SessionCachePayload {
  // Type-compliant and structurally complete: parseSessionCache validates the
  // envelope AND that every asset key/address is present, so a corrupt empty
  // bag ({keys:{}, addresses:{}}) is rejected rather than accepted and then
  // crashed on downstream (keys.btc.publicKey). Per-asset key contents stay
  // opaque to the parser; only presence + type are checked.
  return {
    version: 2,
    _noMnemonic: true,
    fingerprint: 'fp-abcd',
    keys: { btc: {}, ltc: {}, xmr: {}, wow: {}, grin: {} } as unknown as SessionCachePayload['keys'],
    addresses: { btc: 'b', ltc: 'l', xmr: 'x', wow: 'w', grin: 'g' } as SessionCachePayload['addresses'],
    expiresAtMs: 1_700_000_000_000,
  };
}

test('parseSessionCache: accepts a well-formed v2 payload', () => {
  const p = makePayload();
  const parsed = parseSessionCache(p);
  assert.notEqual(parsed, null);
  assert.equal(parsed!.fingerprint, 'fp-abcd');
  assert.equal(parsed!.expiresAtMs, 1_700_000_000_000);
});

test('parseSessionCache: REJECTS a legacy v0.2.x payload (has mnemonic)', () => {
  // This is THE regression guard for the audit finding. If a future
  // commit reintroduces a `mnemonic` field in the cache shape, this
  // test fails.
  const legacy = {
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    fingerprint: 'fp-abcd',
    expiresAtMs: 1_700_000_000_000,
  };
  assert.equal(parseSessionCache(legacy), null);
});

test('parseSessionCache: REJECTS a v2 payload with a smuggled mnemonic field', () => {
  // Defence-in-depth: even if a future code path tries to add the
  // mnemonic alongside the v2 brand, the presence-check kills it.
  const smuggled = {
    ...makePayload(),
    mnemonic: 'attacker injected mnemonic',
  };
  assert.equal(parseSessionCache(smuggled), null);
});

test('parseSessionCache: REJECTS a v3 payload (forces version pin)', () => {
  const futurish = { ...makePayload(), version: 3 };
  assert.equal(parseSessionCache(futurish), null);
});

test('parseSessionCache: REJECTS without the _noMnemonic brand', () => {
  const noBrand = { ...makePayload(), _noMnemonic: false };
  assert.equal(parseSessionCache(noBrand), null);
  const undefBrand: Record<string, unknown> = { ...makePayload() };
  delete undefBrand._noMnemonic;
  assert.equal(parseSessionCache(undefBrand), null);
});

test('parseSessionCache: REJECTS non-finite expiresAtMs', () => {
  const inf = { ...makePayload(), expiresAtMs: Infinity };
  assert.equal(parseSessionCache(inf), null);
  const nan = { ...makePayload(), expiresAtMs: NaN };
  assert.equal(parseSessionCache(nan), null);
});

test('parseSessionCache: REJECTS missing keys / addresses', () => {
  const noKeys: Record<string, unknown> = { ...makePayload() };
  delete noKeys.keys;
  assert.equal(parseSessionCache(noKeys), null);
  const noAddrs: Record<string, unknown> = { ...makePayload() };
  delete noAddrs.addresses;
  assert.equal(parseSessionCache(noAddrs), null);
});

test('parseSessionCache: REJECTS non-object / falsy inputs', () => {
  assert.equal(parseSessionCache(null), null);
  assert.equal(parseSessionCache(undefined), null);
  assert.equal(parseSessionCache(42), null);
  assert.equal(parseSessionCache('payload'), null);
  assert.equal(parseSessionCache([]), null); // arrays are typeof 'object' but don't have the fields
});

// --- restoreUnlockedFromCache ------------------------------------

test('restoreUnlockedFromCache: returned wallet has NO mnemonic and NO seed', () => {
  const w: UnlockedWallet = restoreUnlockedFromCache({
    keys: {} as UnlockedWallet['keys'],
    addresses: {} as UnlockedWallet['addresses'],
    fingerprint: 'fp-xyz',
  });
  assert.equal(w.mnemonic, undefined, 'mnemonic must be undefined');
  assert.equal(w.seed, undefined, 'seed must be undefined');
  assert.equal(w.fingerprint, 'fp-xyz');
});

test('restoreUnlockedFromCache: any future field that would carry the seed is omitted by construction', () => {
  // Inspect the returned object's own keys — if the implementation
  // ever adds a `mnemonic` or `seed` property here, this test
  // fails. (Object.keys excludes prototype props.)
  const w = restoreUnlockedFromCache({
    keys: {} as UnlockedWallet['keys'],
    addresses: {} as UnlockedWallet['addresses'],
    fingerprint: 'fp-1',
  });
  const ownKeys = Object.keys(w).sort();
  assert.deepStrictEqual(
    ownKeys,
    ['addresses', 'fingerprint', 'keys'],
    'restoreUnlockedFromCache must NEVER set mnemonic or seed',
  );
});
