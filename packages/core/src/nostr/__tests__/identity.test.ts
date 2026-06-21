/**
 * Nostr identity derivation tests.
 *
 * The two OFFICIAL NIP-06 test vectors are reproduced verbatim from
 * https://github.com/nostr-protocol/nips/blob/master/06.md so we KNOW our
 * seed -> npub matches every other Nostr client (Goblin included) byte-for-byte.
 * The rest lock in the rotation + signing invariants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveNostrIdentity,
  decodeNpub,
  signNostrEventId,
  verifyNostrEventId,
} from '../identity';

function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

// Verbatim from NIP-06 (nostr-protocol/nips/06.md), account 0.
const NIP06 = [
  {
    mnemonic: 'leader monkey parrot ring guide accident before fence cannon height naive bean',
    priv: '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a',
    pub: '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917',
    npub: 'npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu',
  },
  {
    mnemonic:
      'what bleak badge arrange retreat wolf trade produce cricket blur garlic valid proud rude strong choose busy staff weather area salt hollow arm fade',
    priv: 'c15d739894c81a2fcfd3a2df85a0d2c0dbc47a280d092799f144d73d7ae78add',
    pub: 'd41b22899549e1f3d335a31002cfd382174006e166d3e658e3a5eecdb6463573',
    npub: 'npub16sdj9zv4f8sl85e45vgq9n7nsgt5qphpvmf7vk8r5hhvmdjxx4es8rq74h',
  },
];

NIP06.forEach((v, i) => {
  test(`NIP-06 official vector ${i + 1}: seed -> npub matches the spec`, () => {
    const id = deriveNostrIdentity(v.mnemonic, 0);
    assert.equal(hex(id.privateKey), v.priv, 'private key');
    assert.equal(id.pubkeyHex, v.pub, 'x-only pubkey');
    assert.equal(id.npub, v.npub, 'npub');
  });
});

test('derivation is deterministic', () => {
  const m = NIP06[0].mnemonic;
  assert.equal(deriveNostrIdentity(m, 0).npub, deriveNostrIdentity(m, 0).npub);
});

test('rotation: each hardened account is a distinct identity', () => {
  const m = NIP06[0].mnemonic;
  const npubs = new Set([0, 1, 2, 3].map((a) => deriveNostrIdentity(m, a).npub));
  assert.equal(npubs.size, 4, 'four accounts -> four distinct npubs');
  assert.equal(deriveNostrIdentity(m, 2).account, 2);
});

test('npub encode/decode round-trips to the x-only pubkey', () => {
  const id = deriveNostrIdentity(NIP06[0].mnemonic, 0);
  assert.equal(hex(decodeNpub(id.npub)), id.pubkeyHex);
  assert.ok(id.npub.startsWith('npub1'));
});

test('schnorr sign/verify round-trips over an event id', () => {
  const id = deriveNostrIdentity(NIP06[0].mnemonic, 0);
  const eventId = 'a'.repeat(64); // a 32-byte hex event id
  const sig = signNostrEventId(eventId, id.privateKey);
  assert.equal(sig.length, 128, '64-byte signature, hex');
  assert.ok(verifyNostrEventId(sig, eventId, id.pubkeyHex), 'verifies with our pubkey');
  assert.ok(!verifyNostrEventId(sig, 'b'.repeat(64), id.pubkeyHex), 'fails on a different id');
});

test('invalid account index throws', () => {
  assert.throws(() => deriveNostrIdentity(NIP06[0].mnemonic, -1));
});
