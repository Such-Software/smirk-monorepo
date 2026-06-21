/**
 * NIP-98 auth-event tests: structure, canonical id, signature, and header
 * encoding. The verifier (backend, BIP-340) checks exactly these properties, so
 * locking them in here is what guarantees a Smirk token authenticates anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '@noble/hashes/sha256';
import { base64 } from '@scure/base';

import { deriveNostrIdentity, verifyNostrEventId } from '../identity';
import { buildNip98Event, nip98AuthHeader, payloadHashHex, NIP98_KIND } from '../nip98';

const MNEMONIC = 'leader monkey parrot ring guide accident before fence cannon height naive bean';

function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

test('builds a valid kind-27235 event with u + method tags', () => {
  const id = deriveNostrIdentity(MNEMONIC, 0);
  const ev = buildNip98Event({ url: 'https://backend.smirk.cash/api/v1/auth/me', method: 'get', createdAt: 1_700_000_000 }, id);
  assert.equal(ev.kind, NIP98_KIND);
  assert.equal(ev.content, '');
  assert.equal(ev.pubkey, id.pubkeyHex);
  assert.equal(ev.created_at, 1_700_000_000);
  assert.deepEqual(ev.tags, [
    ['u', 'https://backend.smirk.cash/api/v1/auth/me'],
    ['method', 'GET'], // normalized upper-case
  ]);
});

test('event id is the canonical NIP-01 serialization hash, and the sig verifies', () => {
  const id = deriveNostrIdentity(MNEMONIC, 0);
  const ev = buildNip98Event({ url: 'https://x.test/a', method: 'POST', createdAt: 1_700_000_001 }, id);
  const serial = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  assert.equal(ev.id, hex(sha256(new TextEncoder().encode(serial))), 'id == sha256(canonical)');
  assert.ok(verifyNostrEventId(ev.sig, ev.id, ev.pubkey), 'schnorr sig verifies against id+pubkey');
});

test('payload tag is included and matches the body hash', () => {
  const id = deriveNostrIdentity(MNEMONIC, 0);
  const body = '{"username":"alice"}';
  const ph = payloadHashHex(body);
  assert.equal(ph, hex(sha256(new TextEncoder().encode(body))));
  const ev = buildNip98Event({ url: 'https://x.test/u', method: 'POST', payloadSha256Hex: ph, createdAt: 1 }, id);
  assert.deepEqual(ev.tags[2], ['payload', ph]);
});

test('auth header is "Nostr <base64(event)>" and round-trips', () => {
  const id = deriveNostrIdentity(MNEMONIC, 0);
  const ev = buildNip98Event({ url: 'https://x.test/a', method: 'GET', createdAt: 5 }, id);
  const header = nip98AuthHeader(ev);
  assert.ok(header.startsWith('Nostr '));
  const decoded = JSON.parse(new TextDecoder().decode(base64.decode(header.slice('Nostr '.length))));
  assert.deepEqual(decoded, ev);
});
