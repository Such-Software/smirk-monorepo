/**
 * Wiring tests for the shared NIP-98 auth client methods (used by extension,
 * desktop, and mobile alike). A fake ApiClient records the outgoing request;
 * we assert each method targets the right endpoint, places the NIP-98 token in
 * the right spot (header for login, body for link), and signs a valid event
 * whose `u`/method tags match the request the backend will verify.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64 } from '@scure/base';

import { createAuthMethods } from '../auth';
import type { ApiClient } from '../client';
import { deriveNostrIdentity, verifyNostrEventId } from '../../nostr';

const MNEMONIC = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const BASE = 'https://backend.smirk.cash/api/v1';

interface RecordedCall {
  endpoint: string;
  options: { method?: string; headers?: Record<string, string>; body?: string };
}

function fakeClient(): { client: ApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const rec = async (endpoint: string, options: RecordedCall['options'] = {}) => {
    calls.push({ endpoint, options });
    return { data: {}, status: 200 };
  };
  const client = {
    getBaseUrl: () => BASE,
    request: rec,
    retryableRequest: rec,
  } as unknown as ApiClient;
  return { client, calls };
}

function decodeNostrToken(header: string) {
  assert.ok(header.startsWith('Nostr '), 'token is a "Nostr <base64>" value');
  return JSON.parse(new TextDecoder().decode(base64.decode(header.slice('Nostr '.length))));
}

test('nostrLogin posts a signed NIP-98 token in the Authorization header for /auth/nostr', async () => {
  const { client, calls } = fakeClient();
  const id = deriveNostrIdentity(MNEMONIC, 0);
  await createAuthMethods(client).nostrLogin(id);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, '/auth/nostr');
  assert.equal(calls[0].options.method, 'POST');
  const ev = decodeNostrToken(calls[0].options.headers!.Authorization);
  assert.equal(ev.kind, 27235);
  assert.deepEqual(ev.tags, [['u', `${BASE}/auth/nostr`], ['method', 'POST']]);
  assert.equal(ev.pubkey, id.pubkeyHex);
  assert.ok(verifyNostrEventId(ev.sig, ev.id, ev.pubkey), 'signature verifies');
});

test('linkNostr posts the NIP-98 proof in the body for /auth/nostr/link', async () => {
  const { client, calls } = fakeClient();
  const id = deriveNostrIdentity(MNEMONIC, 0);
  await createAuthMethods(client).linkNostr(id);

  assert.equal(calls[0].endpoint, '/auth/nostr/link');
  assert.equal(calls[0].options.method, 'POST');
  const body = JSON.parse(calls[0].options.body!);
  const ev = decodeNostrToken(body.nostr_token);
  assert.deepEqual(ev.tags, [['u', `${BASE}/auth/nostr/link`], ['method', 'POST']]);
  assert.ok(verifyNostrEventId(ev.sig, ev.id, ev.pubkey), 'signature verifies');
});
