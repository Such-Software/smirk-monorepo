/**
 * NIP-17 DM crypto round-trip (the delicate, Goblin-interop-critical part) via
 * nostr-tools' vetted nip17 — the same wrap/unwrap the NostrMessagingProvider
 * uses. No relay: this pins the gift-wrap correctness, not the transport.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip17';

import { deriveNostrIdentity } from '../../nostr';
import { recipientToHex } from '../dm';

const MNEMONIC =
  'leader monkey parrot ring guide accident before fence cannon height naive bean';

// Two distinct identities from independent hardened accounts of one seed.
const alice = () => deriveNostrIdentity(MNEMONIC, 0);
const bob = () => deriveNostrIdentity(MNEMONIC, 1);
const eve = () => deriveNostrIdentity(MNEMONIC, 2);

test('gift-wrap round-trip: bob decrypts alice DM; rumor author = alice', () => {
  const a = alice();
  const b = bob();
  const wrap = wrapEvent(a.privateKey, { publicKey: b.pubkeyHex }, 'hello bob');
  assert.equal(wrap.kind, 1059, 'gift-wrap kind');

  const rumor = unwrapEvent(wrap, b.privateKey);
  assert.equal(rumor.kind, 14, 'inner DM kind');
  assert.equal(rumor.content, 'hello bob');
  // The load-bearing invariant: the decrypted rumor's author IS the sender.
  assert.equal(rumor.pubkey, a.pubkeyHex, 'sender identity survives the wrap');
});

test('a third party cannot decrypt the gift-wrap', () => {
  const wrap = wrapEvent(alice().privateKey, { publicKey: bob().pubkeyHex }, 'secret');
  assert.throws(() => unwrapEvent(wrap, eve().privateKey), 'eve cannot open it');
});

test('recipientToHex accepts npub and hex, rejects junk', () => {
  const b = bob();
  assert.equal(recipientToHex(b.pubkeyHex), b.pubkeyHex);
  assert.equal(recipientToHex(b.npub), b.pubkeyHex, 'npub decodes to the same hex');
  assert.throws(() => recipientToHex('not-a-key'));
});
