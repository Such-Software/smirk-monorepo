/**
 * NIP-05 resolver tests with a mock fetch: federation (any domain), bare-name
 * home-domain fallback, relay hints, and graceful failure modes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveNip05, splitNip05, homeDomainFromApiBase } from '../nip05';

// NIP-06 vector 1 pubkey, used as a known-good well-known entry.
const PUB = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';

function mockFetch(body: unknown, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

test('splitNip05 handles user@domain, bare name, and a leading @', () => {
  assert.deepEqual(splitNip05('alice@goblin.st', 'smirk.cash'), { name: 'alice', domain: 'goblin.st' });
  assert.deepEqual(splitNip05('bob', 'smirk.cash'), { name: 'bob', domain: 'smirk.cash' });
  assert.deepEqual(splitNip05('@Carol@SMIRK.cash', 'smirk.cash'), { name: 'carol', domain: 'smirk.cash' });
});

test('resolves a name (federated domain) to pubkey + relay hints', async () => {
  const fetchImpl = mockFetch({
    names: { alice: PUB },
    relays: { [PUB]: ['wss://relay.goblin.st', 'wss://nos.lol'] },
  });
  const r = await resolveNip05('alice@goblin.st', { fetchImpl });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.resolution.pubkeyHex, PUB);
    assert.ok(r.resolution.npub.startsWith('npub1'));
    assert.deepEqual(r.resolution.relays, ['wss://relay.goblin.st', 'wss://nos.lol']);
  }
});

test('bare name resolves against the home domain', async () => {
  let calledUrl = '';
  const fetchImpl = (async (url: string) => {
    calledUrl = url;
    return { ok: true, json: async () => ({ names: { bob: PUB } }) } as Response;
  }) as unknown as typeof fetch;
  const r = await resolveNip05('bob', { homeDomain: 'smirk.cash', fetchImpl });
  assert.ok(r.ok);
  assert.match(calledUrl, /^https:\/\/smirk\.cash\/\.well-known\/nostr\.json\?name=bob$/);
});

test('missing name -> not-found; empty relays -> []', async () => {
  const r = await resolveNip05('ghost@smirk.cash', { fetchImpl: mockFetch({ names: {} }) });
  assert.deepEqual(r, { ok: false, error: 'not-found' });
});

test('network error / non-ok -> unreachable', async () => {
  const throwing = (async () => {
    throw new Error('dns');
  }) as unknown as typeof fetch;
  assert.deepEqual(await resolveNip05('a@b.test', { fetchImpl: throwing }), { ok: false, error: 'unreachable' });
  assert.deepEqual(await resolveNip05('a@b.test', { fetchImpl: mockFetch({}, false) }), {
    ok: false,
    error: 'unreachable',
  });
});

test('homeDomainFromApiBase derives the instance host', () => {
  assert.equal(homeDomainFromApiBase('https://api.smirk.cash/api/v1'), 'api.smirk.cash');
  assert.equal(homeDomainFromApiBase('http://127.0.0.1:8080/api/v1'), '127.0.0.1');
  assert.equal(homeDomainFromApiBase('not a url'), 'smirk.cash'); // graceful default
});
