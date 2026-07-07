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
  serializeForSessionCache,
  reviveForSessionCache,
  derivedKeysUsable,
  type SessionCachePayload,
  type UnlockedWallet,
} from '../keystore';

// --- session-cache Uint8Array round-trip (the auto-unlock sign-in bug) --------

/** Simulate chrome.storage.session, which serializes a Uint8Array into a plain
 *  numeric-keyed object — the exact mangling that broke restore. */
const throughStorage = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

function fakeKeys() {
  return {
    btc: { privateKey: new Uint8Array(32).fill(1), publicKey: new Uint8Array(33).fill(2) },
    ltc: { privateKey: new Uint8Array(32).fill(3), publicKey: new Uint8Array(33).fill(4) },
    xmr: { privateSpendKey: new Uint8Array(32).fill(5), publicSpendKey: new Uint8Array(32).fill(6) },
  };
}

test('serialize -> storage-mangle -> revive restores Uint8Array key material', () => {
  const keys = fakeKeys();
  const restored = reviveForSessionCache(
    throughStorage(serializeForSessionCache(keys)),
  ) as ReturnType<typeof fakeKeys>;
  assert.ok(restored.btc.privateKey instanceof Uint8Array, 'btc privkey is Uint8Array');
  assert.equal(restored.btc.privateKey.length, 32);
  assert.deepEqual(Array.from(restored.btc.privateKey), Array.from(keys.btc.privateKey));
  assert.ok(restored.xmr.privateSpendKey instanceof Uint8Array);
  assert.deepEqual(Array.from(restored.ltc.publicKey), Array.from(keys.ltc.publicKey));
});

test('revive self-heals a legacy numeric-object cache (no __u8 marker)', () => {
  // A pre-fix cache stored the raw Uint8Array, which chrome flattened to {0:..}.
  const broken = throughStorage(fakeKeys()) as Record<string, { privateKey: unknown }>;
  assert.ok(!(broken.btc.privateKey instanceof Uint8Array)); // precondition: mangled
  const revived = reviveForSessionCache(broken) as ReturnType<typeof fakeKeys>;
  assert.ok(revived.btc.privateKey instanceof Uint8Array);
  assert.equal(revived.btc.privateKey.length, 32);
});

test('derivedKeysUsable gates on real 32-byte BTC/LTC signing keys', () => {
  assert.equal(derivedKeysUsable(fakeKeys() as never), true);
  // Lost bytes (mangled, not revived) → not usable → force re-unlock.
  assert.equal(derivedKeysUsable(throughStorage(fakeKeys()) as never), false);
  assert.equal(derivedKeysUsable(undefined), false);
});

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
