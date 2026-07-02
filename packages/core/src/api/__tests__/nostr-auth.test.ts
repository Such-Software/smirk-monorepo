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
import {
  deriveNostrIdentity,
  descriptorSha256,
  requestDescriptor,
  verifyNostrEventId,
} from '../../nostr';

const MNEMONIC = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const BASE = 'https://backend.smirk.cash/api/v1';
const LINK_NONCE = 'test-nonce-abcdef0123456789abcdef0123456789';

interface RecordedCall {
  endpoint: string;
  options: { method?: string; headers?: Record<string, string>; body?: string };
}

function fakeClient(): { client: ApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const rec = async (endpoint: string, options: RecordedCall['options'] = {}) => {
    calls.push({ endpoint, options });
    // The link flow first GETs a nonce; hand one back so it proceeds to POST.
    if (endpoint.includes('link-challenge')) {
      return { data: { nonce: LINK_NONCE }, status: 200 };
    }
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

test('linkNostr fetches a challenge, then posts a signed-action proof + nonce to /auth/nostr/link', async () => {
  const { client, calls } = fakeClient();
  const id = deriveNostrIdentity(MNEMONIC, 0);
  await createAuthMethods(client).linkNostr(id);

  // Two calls: GET the single-use nonce, then POST the proof that binds it.
  assert.equal(calls.length, 2, 'challenge then link');
  assert.equal(calls[0].endpoint, '/auth/nostr/link-challenge');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].endpoint, '/auth/nostr/link');
  assert.equal(calls[1].options.method, 'POST');

  const body = JSON.parse(calls[1].options.body!);
  assert.equal(body.nonce, LINK_NONCE, 'the fetched nonce is submitted');
  const ev = decodeNostrToken(body.nostr_token);

  // The signed action binds u/method/purpose/challenge/payload — the exact shape
  // the server's verify_signed_action checks.
  const expectedPayload = descriptorSha256(
    requestDescriptor('POST', '/api/v1/auth/nostr/link', '', ''),
  );
  assert.deepEqual(ev.tags, [
    ['u', `${BASE}/auth/nostr/link`],
    ['method', 'POST'],
    ['purpose', 'nostr_link'],
    ['challenge', LINK_NONCE],
    ['payload', expectedPayload],
  ]);
  assert.ok(verifyNostrEventId(ev.sig, ev.id, ev.pubkey), 'signature verifies');
});

test('nostr_link descriptor payload matches the backend cross-impl KAT', () => {
  // MUST equal the pinned value in smirk-backend-core tests/nostr_auth.rs
  // (NOSTR_LINK_DESCRIPTOR_SHA256) — the client and server bind the identical
  // descriptor, so this literal is the cross-impl contract.
  const payload = descriptorSha256(requestDescriptor('POST', '/api/v1/auth/nostr/link', '', ''));
  assert.equal(payload, '8d6aaf2ed65252d1be6090415915736c40d775b9f12ade15c3af71bc02cdcc49');
});
