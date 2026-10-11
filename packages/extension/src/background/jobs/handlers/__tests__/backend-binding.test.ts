/**
 * The background sign-in talks only to the backend its job names. A sign-in
 * sends the wallet's public keys and a signed proof, so a context pointed
 * anywhere else must refuse before the first request, not after.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '@smirk/core';

import { bootstrapAuthHandler } from '../bootstrap-auth';

const KEYS = [{ asset: 'btc', publicKey: '02'.padEnd(66, 'a') }];

function recordCalls(t: TestContext): string[] {
  const calls: string[] = [];
  const mock = (method: string, reply: unknown) =>
    t.mock.method(api as unknown as Record<string, () => unknown>, method, (async () => {
      calls.push(method);
      return reply;
    }) as () => unknown);
  mock('checkRestore', { status: 200, data: { exists: true, keysValid: true } });
  mock('powChallenge', { error: 'not expected' });
  mock('extensionRegister', {
    status: 200,
    data: { accessToken: 'tok', refreshToken: 'r', expiresIn: 1, isNew: false, user: { id: 'u' } },
  });
  return calls;
}

function pointAt(t: TestContext, url: string): void {
  const previous = api.getBaseUrl();
  api.setBaseUrl(url);
  t.after(() => api.setBaseUrl(previous));
}

test('a sign-in for another backend sends nothing', async (t) => {
  pointAt(t, 'http://127.0.0.1:18702/api/v1');
  const calls = recordCalls(t);
  await assert.rejects(
    bootstrapAuthHandler.run(
      {
        backend: { url: 'http://127.0.0.1:18701/api/v1', apiStyle: 'namespaced' },
        fingerprint: 'fp-test',
        keys: KEYS,
        signedTimestamp: 1_790_000_000,
        signature: 'sig',
      },
      { signal: new AbortController().signal } as never,
    ),
  );
  assert.deepEqual(calls, [], 'the wrong backend was contacted');
});

test('a completed sign-in says which backend minted its token', async (t) => {
  const url = 'http://127.0.0.1:18701/api/v1';
  pointAt(t, url);
  recordCalls(t);
  const result = await bootstrapAuthHandler.run(
    {
      backend: { url, apiStyle: 'namespaced' },
      fingerprint: 'fp-test',
      keys: KEYS,
      signedTimestamp: 1_790_000_000,
      signature: 'sig',
    },
    { signal: new AbortController().signal } as never,
  );
  assert.equal(result.backendUrl, url);
});
