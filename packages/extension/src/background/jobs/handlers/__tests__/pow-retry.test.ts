/**
 * The offscreen `bootstrap-auth` job (the BTC path for backends without
 * npub-native sign-in) when the backend refuses the known-wallet fast path.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createChallenge } from 'altcha-lib';
import { api, NOSTR_IDENTITY_CONFLICT } from '@smirk/core';

import { bootstrapAuthHandler } from '../bootstrap-auth';

const LEGACY_POW_REFUSAL = {
  status: 400,
  code: 'VALIDATION_ERROR',
  error: 'Proof-of-work solution is required to create a new wallet. Please upgrade to a newer Smirk client.',
};

/** smirk-backend-core 45b0143 `NOSTR_ROW_ADOPT_REFUSED`, as the API client returns it. */
const NOSTR_ROW_ADOPT_REFUSAL = {
  status: 409,
  code: 'CONFLICT',
  error: 'This account is registered under a Nostr identity; sign in with it',
};

const KEYS = [{ asset: 'btc', publicKey: '02'.padEnd(66, 'a') }];

function knownWallet(t: TestContext) {
  const mock = (method: string, impl: (...a: never[]) => unknown): void => {
    t.mock.method(api as unknown as Record<string, () => unknown>, method, impl as () => unknown);
  };
  mock('checkRestore', async () => ({
    status: 200,
    data: { exists: true, keysValid: true, xmrStartHeight: 100, wowStartHeight: 200 },
  }));
  let challenges = 0;
  mock('powChallenge', async () => {
    challenges += 1;
    return {
      status: 200,
      data: await createChallenge({
        hmacKey: 'offscreen-pow-retry-test-only',
        algorithm: 'PBKDF2/SHA-256',
        cost: 100,
        maxnumber: 10,
        saltLength: 8,
      }),
    };
  });
  return { challenges: () => challenges, mock };
}

test('a known fingerprint refused for want of PoW solves once and resends the same signed request', async (t) => {
  const backend = knownWallet(t);
  const sent: Array<Record<string, unknown>> = [];
  backend.mock('extensionRegister', async (params: Record<string, unknown>) => {
    sent.push(params);
    return params.altchaSolution
      ? { status: 200, data: { accessToken: 'tok', refreshToken: 'r', expiresIn: 1, isNew: true, user: { id: 'u' } } }
      : LEGACY_POW_REFUSAL;
  });

  const input = {
    fingerprint: 'fp-test',
    keys: KEYS,
    signedTimestamp: 1_790_000_000,
    signature: 'sig-from-popup',
    rotationPublicKey: '03'.padEnd(66, 'b'),
    rotationSignature: 'rotation-sig-from-popup',
  };
  const result = await bootstrapAuthHandler.run(input, { signal: new AbortController().signal } as never);

  assert.equal(result.accessToken, 'tok');
  assert.equal(result.bootstrap.restoreState, 'existing');
  assert.equal(backend.challenges(), 1);
  assert.equal(sent.length, 2);
  assert.equal('altchaSolution' in sent[0]!, false, 'the fast path sends no solution');
  assert.ok(sent[1]!.altchaSolution, 'the resend carries one');
  assert.equal(sent[1]!.signature, input.signature);
  assert.equal(sent[1]!.signedTimestamp, input.signedTimestamp);
  assert.deepStrictEqual(sent[1]!.keys, sent[0]!.keys);
  for (const body of sent) {
    assert.equal(body.rotationPublicKey, input.rotationPublicKey, 'the pre-v0.3 proof rides on both attempts');
    assert.equal(body.rotationSignature, input.rotationSignature);
  }
});

test('an unknown fingerprint never sends a rotation proof', async (t) => {
  const backend = knownWallet(t);
  backend.mock('checkRestore', async () => ({ status: 200, data: { exists: false, keysValid: null } }));
  const sent: Array<Record<string, unknown>> = [];
  backend.mock('extensionRegister', async (params: Record<string, unknown>) => {
    sent.push(params);
    return { status: 200, data: { accessToken: 'tok', refreshToken: 'r', expiresIn: 1, isNew: true, user: { id: 'u' } } };
  });
  await bootstrapAuthHandler.run(
    {
      fingerprint: 'fp-new',
      keys: KEYS,
      signedTimestamp: 1_790_000_000,
      signature: 'sig',
      rotationPublicKey: '03'.padEnd(66, 'b'),
      rotationSignature: 'rotation-sig',
    },
    { signal: new AbortController().signal } as never,
  );
  assert.equal(sent.length, 1);
  assert.equal('rotationPublicKey' in sent[0]!, false);
  assert.equal('rotationSignature' in sent[0]!, false);
});

test('a registration failure is logged without the seed fingerprint', async (t) => {
  const backend = knownWallet(t);
  backend.mock('extensionRegister', async () => ({ status: 401, code: 'AUTH_ERROR', error: 'Invalid signature' }));
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logged.push(args);
  });

  const fingerprint = `fp-${crypto.randomUUID()}`;
  await assert.rejects(
    bootstrapAuthHandler.run(
      { fingerprint, keys: KEYS, signedTimestamp: 1_790_000_000, signature: 'sig' },
      { signal: new AbortController().signal } as never,
    ),
    /Invalid signature/,
  );
  assert.ok(logged.length > 0, 'the failure is still logged');
  assert.ok(!JSON.stringify(logged).includes(fingerprint), 'but never with the fingerprint');
  assert.equal(backend.challenges(), 0, 'an authentication failure is not a PoW refusal');
});

test('an adopt refused for another Nostr identity is neither solved nor resent, and says what to do', async (t) => {
  const backend = knownWallet(t);
  const sent: Array<Record<string, unknown>> = [];
  backend.mock('extensionRegister', async (params: Record<string, unknown>) => {
    sent.push(params);
    return NOSTR_ROW_ADOPT_REFUSAL;
  });
  t.mock.method(console, 'error', () => undefined);
  await assert.rejects(
    bootstrapAuthHandler.run(
      { fingerprint: 'fp-test', keys: KEYS, signedTimestamp: 1_790_000_000, signature: 'sig' },
      { signal: new AbortController().signal } as never,
    ),
    (e: unknown) =>
      e instanceof Error &&
      e.message === NOSTR_IDENTITY_CONFLICT &&
      !/proof-of-work|upgrade|update|newer|latest/i.test(e.message),
  );
  assert.equal(backend.challenges(), 0, 'no solve for a refusal no solve can change');
  assert.equal(sent.length, 1, 'nothing is resent');
  assert.equal('altchaSolution' in sent[0]!, false);
});

test('when no solve can run, the job fails as retryable, not as advice to upgrade', async (t) => {
  const backend = knownWallet(t);
  backend.mock('powChallenge', async () => ({ error: 'offline' }));
  let sent = 0;
  backend.mock('extensionRegister', async () => {
    sent += 1;
    return LEGACY_POW_REFUSAL;
  });
  t.mock.method(console, 'error', () => undefined);
  await assert.rejects(
    bootstrapAuthHandler.run(
      { fingerprint: 'fp-test', keys: KEYS, signedTimestamp: 1_790_000_000, signature: 'sig' },
      { signal: new AbortController().signal } as never,
    ),
    (e: unknown) => e instanceof Error && /proof-of-work/i.test(e.message) && !/upgrade|update|newer|latest/i.test(e.message),
  );
  assert.equal(sent, 1, 'nothing is resent without a solution');
});
