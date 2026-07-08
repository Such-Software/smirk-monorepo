/**
 * Cached, TOFU-pinning NIP-05 resolver (federation hardening). Proves: first-seen
 * pins; a subsequent SAME key is cache-served (no re-fetch); a CHANGED key is flagged
 * and NOT auto-accepted; confirmPin accepts the new key; TTL expiry re-fetches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNip05Resolver, type Nip05PinStore } from '../nip05-cache';

const PK_A = 'aa'.repeat(32);
const PK_B = 'bb'.repeat(32);

function memPins(): Nip05PinStore {
  const m = new Map<string, string>();
  return { async get(k) { return m.get(k) ?? null; }, async set(k, v) { m.set(k, v); } };
}

/** A fetch stub that serves a well-known mapping `name -> pubkey`, counting calls. */
function stubFetch(pubkeyByName: Record<string, string>) {
  const calls = { n: 0 };
  const fetchImpl = (async (url: string) => {
    calls.n++;
    const name = new URL(url).searchParams.get('name') ?? '';
    const pk = pubkeyByName[name];
    return {
      ok: true,
      async json() {
        return pk ? { names: { [name]: pk }, relays: {} } : { names: {}, relays: {} };
      },
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test('first resolve pins (TOFU); the same key is served from cache (no re-fetch)', async () => {
  const { fetchImpl, calls } = stubFetch({ alice: PK_A });
  let clock = 1000;
  const r = createNip05Resolver({ pins: memPins(), fetchImpl, now: () => clock });

  const first = await r.resolve('alice@goblin.st');
  assert.equal(first.ok && first.keyChanged, false);
  assert.equal(first.ok && first.resolution.pubkeyHex, PK_A);
  assert.equal(calls.n, 1);

  clock += 1000; // still within TTL
  const second = await r.resolve('alice@goblin.st');
  assert.equal(second.ok && second.keyChanged, false);
  assert.equal(calls.n, 1, 'served from cache — no second fetch');
});

test('a CHANGED key is flagged keyChanged and NOT auto-accepted', async () => {
  const stub = stubFetch({ alice: PK_A });
  const pins = memPins();
  let clock = 1000;
  const r = createNip05Resolver({ pins, fetchImpl: stub.fetchImpl, now: () => clock });

  await r.resolve('alice@goblin.st'); // pins PK_A
  clock += 10 * 60 * 1000; // past TTL → re-fetch
  // The domain now returns a DIFFERENT key (substitution).
  const stub2 = stubFetch({ alice: PK_B });
  const r2 = createNip05Resolver({ pins, fetchImpl: stub2.fetchImpl, now: () => clock });

  const changed = await r2.resolve('alice@goblin.st');
  assert.ok(changed.ok && changed.keyChanged === true);
  assert.equal(changed.ok && changed.keyChanged && changed.pinnedPubkeyHex, PK_A);
  assert.equal(changed.ok && changed.resolution.pubkeyHex, PK_B); // the new (untrusted) key
  // The pin was NOT overwritten.
  assert.equal(await pins.get('alice@goblin.st'), PK_A);
});

test('confirmPin accepts the new key; subsequent resolve is unchanged', async () => {
  const pins = memPins();
  await pins.set('alice@goblin.st', PK_A);
  let clock = 1000;
  const stub = stubFetch({ alice: PK_B });
  const r = createNip05Resolver({ pins, fetchImpl: stub.fetchImpl, now: () => clock });

  const changed = await r.resolve('alice@goblin.st');
  assert.ok(changed.ok && changed.keyChanged === true);

  await r.confirmPin('alice@goblin.st', PK_B);
  clock += 1; // cache was dropped by confirmPin → re-resolve
  const ok = await r.resolve('alice@goblin.st');
  assert.equal(ok.ok && ok.keyChanged, false);
  assert.equal(await pins.get('alice@goblin.st'), PK_B);
});

test('TTL expiry re-fetches (same key stays unchanged)', async () => {
  const { fetchImpl, calls } = stubFetch({ alice: PK_A });
  let clock = 1000;
  const r = createNip05Resolver({ pins: memPins(), fetchImpl, ttlMs: 1000, now: () => clock });

  await r.resolve('alice@goblin.st');
  assert.equal(calls.n, 1);
  clock += 2000; // past the 1s TTL
  const again = await r.resolve('alice@goblin.st');
  assert.equal(again.ok && again.keyChanged, false);
  assert.equal(calls.n, 2, 'stale cache → re-fetch');
});

test('an unresolvable name returns the error, does not pin', async () => {
  const pins = memPins();
  const { fetchImpl } = stubFetch({}); // no names
  const r = createNip05Resolver({ pins, fetchImpl });
  const res = await r.resolve('ghost@goblin.st');
  assert.equal(res.ok, false);
  assert.equal(await pins.get('ghost@goblin.st'), null);
});
