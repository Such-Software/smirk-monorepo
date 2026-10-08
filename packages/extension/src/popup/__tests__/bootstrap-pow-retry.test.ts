/**
 * The extension bootstrap against a backend that refuses the known-wallet fast
 * path (production capabilities: npub-native sign-in first, BTC fallback).
 *
 * A pre-v0.3 wallet's seed fingerprint is on file but neither its npub nor its
 * v0.3 BTC key is, so both register routes refuse a request without a PoW
 * solution. The store v0.3.0 client never solved and surfaced the backend's
 * "upgrade to a newer Smirk client" refusal on every import and unlock.
 *
 * Fixture: the standard BIP39 test vector phrase, never a real wallet.
 */

import './_chrome-stub';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createChallenge, type Challenge } from 'altcha-lib';
import { api, deriveAllKeys, mnemonicToSeed } from '@smirk/core';
import type { UnlockedWallet } from '@smirk/core';

import { bootstrapAuthInExtension } from '../jobs/bootstrap-in-extension';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const LEGACY_POW_REFUSAL = {
  status: 400,
  code: 'VALIDATION_ERROR',
  error: 'Proof-of-work solution is required to create a new wallet. Please upgrade to a newer Smirk client.',
};

function signedIn(isNew: boolean) {
  return {
    status: 200,
    data: { accessToken: 'tok', refreshToken: 'rtok', expiresIn: 86400, isNew, user: { id: 'user-1' } },
  };
}

function phraseWallet(): UnlockedWallet {
  return {
    fingerprint: `fp-${crypto.randomUUID()}`,
    mnemonic: PHRASE,
    seed: mnemonicToSeed(PHRASE),
    keys: deriveAllKeys(PHRASE, '', 3),
    addresses: { btc: 'x', ltc: 'x', xmr: 'x', wow: 'x', grin: 'x' },
  } as unknown as UnlockedWallet;
}

async function tinyChallenge(): Promise<Challenge> {
  return await createChallenge({
    hmacKey: 'bootstrap-pow-retry-test-only',
    algorithm: 'PBKDF2/SHA-256',
    cost: 100,
    maxnumber: 10,
    saltLength: 8,
  });
}

type Calls = { nostr: Array<Record<string, unknown>>; btc: Array<Record<string, unknown>>; challenges: number };

/** Mock the npub-native backend. `exists` is what check-restore reports. */
function mockBackend(
  t: TestContext,
  exists: boolean,
  replies: {
    nostr: (params: Record<string, unknown>, index: number) => unknown;
    btc?: (params: Record<string, unknown>, index: number) => unknown;
    challenge?: (index: number) => Promise<unknown>;
  },
): Calls {
  const calls: Calls = { nostr: [], btc: [], challenges: 0 };
  const mock = (method: string, impl: (...a: never[]) => unknown): void => {
    t.mock.method(api as unknown as Record<string, () => unknown>, method, impl as () => unknown);
  };
  mock('getCapabilities', async () => ({ status: 200, data: { features: { nostr_native_auth: true } } }));
  mock('checkRestore', async () => ({
    status: 200,
    data: exists
      ? { exists: true, keysValid: true, xmrStartHeight: 100, wowStartHeight: 200 }
      : { exists: false, keysValid: null },
  }));
  mock('nostrRegister', async (params: Record<string, unknown>) => {
    calls.nostr.push(params);
    return replies.nostr(params, calls.nostr.length - 1);
  });
  mock('extensionRegister', async (params: Record<string, unknown>) => {
    calls.btc.push(params);
    if (!replies.btc) throw new Error('unexpected BTC registration');
    return replies.btc(params, calls.btc.length - 1);
  });
  mock('powChallenge', async () => {
    calls.challenges += 1;
    return replies.challenge ? replies.challenge(calls.challenges - 1) : { status: 200, data: await tinyChallenge() };
  });
  return calls;
}

test('a pre-v0.3 wallet refused for want of PoW on npub sign-in falls back to BTC, which solves once and signs in', async (t) => {
  const calls = mockBackend(t, true, {
    nostr: () => LEGACY_POW_REFUSAL,
    // auth.rs rotation branch: the proof is valid, but PoW is still enforced.
    btc: (params) => (params.altchaSolution ? signedIn(false) : LEGACY_POW_REFUSAL),
  });

  const bootstrap = await bootstrapAuthInExtension(api, phraseWallet());

  assert.equal(bootstrap.userId, 'user-1');
  assert.equal(bootstrap.restoreState, 'existing');
  assert.equal(api.getAccessToken(), 'tok');
  assert.equal(calls.nostr.length, 1, 'no wasted solve or resend on the npub route');
  assert.equal('altchaSolution' in calls.nostr[0]!, false);
  assert.equal(calls.challenges, 1, 'exactly one proof-of-work solve');
  assert.equal(calls.btc.length, 2, 'the refused BTC sign-in is resent once');
  const [first, second] = calls.btc as [Record<string, unknown>, Record<string, unknown>];
  assert.equal('altchaSolution' in first, false);
  assert.ok(second.altchaSolution, 'the resend carries the solution');
  assert.deepStrictEqual(second.keys, first.keys);
  assert.ok(first.rotationPublicKey && second.rotationPublicKey, 'both carry the pre-v0.3 rotation proof');
  assert.equal(second.rotationPublicKey, first.rotationPublicKey);
});

test('a 409 from npub sign-in still falls back to BTC', async (t) => {
  const calls = mockBackend(t, true, {
    nostr: () => ({ status: 409, code: 'CONFLICT', error: 'This wallet already has an account.' }),
    btc: () => signedIn(false),
  });
  const bootstrap = await bootstrapAuthInExtension(api, phraseWallet());
  assert.equal(bootstrap.userId, 'user-1');
  assert.equal(calls.btc.length, 1);
  assert.equal(calls.challenges, 0, 'a returning BTC key needs no solve');
});

test('a known wallet whose npub sign-in fails for another reason does not fall back to BTC', async (t) => {
  const calls = mockBackend(t, true, {
    nostr: () => ({ status: 429, code: 'RATE_LIMITED', error: 'Rate limited' }),
  });
  await assert.rejects(bootstrapAuthInExtension(api, phraseWallet()), /Rate limited/);
  assert.equal(calls.btc.length, 0, 'a rate limit would only double on the BTC route');
  assert.equal(calls.challenges, 0);
});

test('a new wallet whose own solve failed resends once with a solution when the backend insists', async (t) => {
  const calls = mockBackend(t, false, {
    nostr: (params) =>
      params.altchaSolution
        ? signedIn(true)
        : { status: 400, code: 'POW_REQUIRED', error: 'A proof-of-work solution is required.' },
    // The first solve's three challenge fetches fail; the retry's succeeds.
    challenge: async (index) =>
      index < 3 ? { error: 'offline' } : { status: 200, data: await tinyChallenge() },
  });

  const bootstrap = await bootstrapAuthInExtension(api, phraseWallet());

  assert.equal(bootstrap.restoreState, 'new');
  assert.equal(bootstrap.isNew, true);
  assert.equal(calls.nostr.length, 2);
  assert.equal('altchaSolution' in calls.nostr[0]!, false);
  assert.ok(calls.nostr[1]!.altchaSolution);
  assert.equal(calls.btc.length, 0, 'a new wallet never falls back to BTC on a PoW refusal');
});

test('when no solve can run, the refusal reads as retryable, not as advice to upgrade', async (t) => {
  const calls = mockBackend(t, false, {
    nostr: () => LEGACY_POW_REFUSAL,
    challenge: async () => ({ error: 'offline' }),
  });
  await assert.rejects(
    bootstrapAuthInExtension(api, phraseWallet()),
    (e: unknown) => e instanceof Error && /proof-of-work/i.test(e.message) && !/upgrade|update|newer|latest/i.test(e.message),
  );
  assert.equal(calls.nostr.length, 1, 'nothing is resent without a solution');
  assert.equal(calls.btc.length, 0);
});
