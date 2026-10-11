/**
 * The background sign-in talks only to the backend its job names. A sign-in
 * sends the wallet's public keys and a signed proof, so a context pointed
 * anywhere else must refuse before the first request, not after.
 *
 * And it stays there: the context's shared `api` singleton can be re-pointed
 * while the job awaits the network (the service worker following another
 * window's switch, or a later job in Chrome's shared offscreen document). The
 * review of #46 reproduced a job that checked restore state at one backend,
 * registered at the other, and named the first as the token's minter.
 *
 * Requests are answered by a stub `fetch`; tokens are random and never printed.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { api, applyBackendConfig } from '@smirk/core';

import { bootstrapAuthHandler } from '../bootstrap-auth';

const A = { url: 'http://127.0.0.1:18701/api/v1', apiStyle: 'namespaced' as const };
const B = { url: 'http://127.0.0.1:18702/api/v1', apiStyle: 'namespaced' as const };
const KEYS = [{ asset: 'btc', publicKey: '02'.padEnd(66, 'a') }];

/**
 * Answer the sign-in's requests. `during(url)` runs as each request arrives,
 * before its reply, so a test can re-point the singleton mid-request.
 */
function backends(t: TestContext, token: string, during: (url: string) => void = () => undefined) {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    during(url);
    let body: unknown;
    if (url.endsWith('/auth/check-restore')) {
      body = { exists: true, keys_valid: true };
    } else if (url.endsWith('/auth/extension')) {
      body = { access_token: token, refresh_token: 'r', expires_in: 60, is_new: false, user: { id: 'u' } };
    } else {
      return new Response('{"error":"unexpected"}', { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return seen;
}

function pointAt(t: TestContext, backend: typeof A): void {
  const previous = { url: api.getBaseUrl(), apiStyle: api.getWalletApiStyle() };
  applyBackendConfig(backend);
  t.after(() => applyBackendConfig(previous));
}

function signInAt(backend: typeof A) {
  return bootstrapAuthHandler.run(
    { backend, fingerprint: 'fp-test', keys: KEYS, signedTimestamp: 1_790_000_000, signature: 'sig' },
    { signal: new AbortController().signal } as never,
  );
}

test('a sign-in for another backend sends nothing', async (t) => {
  pointAt(t, B);
  const seen = backends(t, crypto.randomUUID());
  await assert.rejects(signInAt(A));
  assert.deepEqual(seen, [], 'the wrong backend was contacted');
});

test('a completed sign-in says which backend minted its token', async (t) => {
  pointAt(t, A);
  const token = crypto.randomUUID();
  const seen = backends(t, token);
  const result = await signInAt(A);
  assert.equal(result.backendUrl, A.url);
  assert.equal(result.accessToken, token);
  assert.ok(seen.length > 0 && seen.every((url) => url.startsWith(A.url)));
});

test('a context re-pointed mid-job does not move the sign-in', async (t) => {
  pointAt(t, A);
  const token = crypto.randomUUID();
  const seen = backends(t, token, (url) => {
    // Another window resets or switches while check-restore is in flight.
    if (url.endsWith('/auth/check-restore')) applyBackendConfig(B);
  });

  const result = await signInAt(A);

  assert.equal(api.getBaseUrl(), B.url, 'the probe did not re-point the context');
  const registered = seen.filter((url) => url.endsWith('/auth/extension'));
  assert.equal(registered.length, 1);
  assert.ok(registered[0]!.startsWith(A.url), 'the registration followed the re-pointed singleton');
  assert.ok(seen.every((url) => url.startsWith(A.url)), 'a sign-in request reached the other backend');
  assert.equal(result.backendUrl, A.url, 'the result names a backend other than the minter');
});
