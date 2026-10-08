/**
 * Background polls stop presenting an access token the backend refused, and
 * pick up again once the next unlock or bootstrap installs a new one.
 *
 * Production 2026-10-06: one v0.3.0 window polled GET /tips/social/received and
 * GET /wallet/grin/relay/pending once a minute with an expired token for about
 * five hours, 285 401s each.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '@smirk/core';

import { startBackgroundPoll } from '../background-poll';

/** Let the mocked fetch and the client's body parsing settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

test('a poll whose token the backend refused stops sending it until a new token is installed', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sent: Array<string | undefined> = [];
  let status = 401;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    sent.push((init?.headers as Record<string, string> | undefined)?.Authorization);
    return new Response(JSON.stringify(status === 200 ? { tips: [] } : { error: 'Invalid or expired token', code: 'AUTH_ERROR' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
    api.setAccessToken(null);
  });

  api.setAccessToken('expired-token');
  const stop = startBackgroundPoll(api, () => api.getReceivedSocialTips(), 30_000, { immediate: true });
  t.after(stop);
  await settle();
  assert.deepStrictEqual(sent, ['Bearer expired-token']);

  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(30_000);
    await settle();
  }
  assert.equal(sent.length, 1, 'no further request carries the refused token');

  // The next unlock or bootstrap installs a fresh token.
  api.setAccessToken('fresh-token');
  status = 200;
  t.mock.timers.tick(30_000);
  await settle();
  assert.deepStrictEqual(sent, ['Bearer expired-token', 'Bearer fresh-token']);

  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(sent.length, 3, 'and keeps polling while the token is accepted');
});

test('a stopped poll never ticks again', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let ticks = 0;
  const stop = startBackgroundPoll({ isSessionRejected: () => false }, () => (ticks += 1), 1_000);
  t.mock.timers.tick(3_000);
  stop();
  t.mock.timers.tick(5_000);
  assert.equal(ticks, 3);
});
