/**
 * The API client remembers when the backend refuses the current access token,
 * so background polls can stop presenting it (see `isSessionRejected`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiClient } from '../client';

const BASE = 'http://mock.test/api/v1';

/** Answer every request with `status`; record the Authorization header sent. */
function withStatus(status: number, onSend?: () => void) {
  const seen: Array<string | undefined> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string> | undefined)?.Authorization);
    onSend?.();
    return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: 'nope', code: 'AUTH_ERROR' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return {
    seen,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('a 401 to a GET that carried the session token marks that token rejected until a new one is set', async (t) => {
  const client = new ApiClient(BASE);
  client.setAccessToken('expired-token');
  const backend = withStatus(401);
  t.after(backend.restore);

  assert.equal(client.isSessionRejected(), false);
  const res = await client.request('/tips/social/received', { method: 'GET' });
  assert.equal(res.status, 401);
  assert.equal(backend.seen[0], 'Bearer expired-token');
  assert.equal(client.isSessionRejected(), true);

  client.setAccessToken('fresh-token');
  assert.equal(client.isSessionRejected(), false, 'the next bootstrap starts clean');
  // An explicit install is presumed live even when it repeats the refused token
  // (the popup's warm path re-installs a cached one), and forgets the refusal.
  await client.request('/tips/social/received', { method: 'GET' });
  assert.equal(client.isSessionRejected(), true);
  client.setAccessToken('fresh-token');
  assert.equal(client.isSessionRejected(), false, 'a reinstalled token is presumed live');
  client.setAccessToken(null);
  assert.equal(client.isSessionRejected(), false, 'no token, nothing rejected');
});

test('a GET without an explicit method counts as a GET', async (t) => {
  const client = new ApiClient(BASE);
  client.setAccessToken('expired-token');
  const backend = withStatus(401);
  t.after(backend.restore);
  await client.request('/wallet/grin/relay/pending');
  assert.equal(client.isSessionRejected(), true);
});

test('a 401 to a POST says nothing about the token', async (t) => {
  // POST handlers also answer 401 for a bad proof in the body (NIP-98, a link
  // nonce, an erasure proof) while the bearer is fine.
  const client = new ApiClient(BASE);
  client.setAccessToken('live-token');
  const backend = withStatus(401);
  t.after(backend.restore);
  await client.request('/auth/nostr/link', { method: 'POST', body: '{}' });
  assert.equal(client.isSessionRejected(), false);
});

test('a 401 to a request that carried its own Authorization leaves the session alone', async (t) => {
  const client = new ApiClient(BASE);
  client.setAccessToken('live-token');
  const backend = withStatus(401);
  t.after(backend.restore);
  await client.request('/auth/nostr', { method: 'GET', headers: { Authorization: 'Nostr abc' } });
  assert.equal(backend.seen[0], 'Nostr abc');
  assert.equal(client.isSessionRejected(), false);
});

test('a 401 that lands after a new token was installed does not mark the new token', async (t) => {
  const client = new ApiClient(BASE);
  client.setAccessToken('old-token');
  // The re-bootstrap finishes while the old token's poll is still in flight.
  const backend = withStatus(401, () => client.setAccessToken('new-token'));
  t.after(backend.restore);
  await client.request('/tips/social/sent', { method: 'GET' });
  assert.equal(client.getAccessToken(), 'new-token');
  assert.equal(client.isSessionRejected(), false);
});

test('success and other failures leave the session alone', async () => {
  const client = new ApiClient(BASE);
  client.setAccessToken('live-token');
  for (const status of [200, 403, 429, 500]) {
    const backend = withStatus(status);
    await client.request('/tips/social/received', { method: 'GET' });
    backend.restore();
    assert.equal(client.isSessionRejected(), false, `HTTP ${status}`);
  }
});
