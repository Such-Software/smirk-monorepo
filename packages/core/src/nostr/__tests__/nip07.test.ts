/**
 * NIP-07 crypto round-trips (the window.nostr encrypt/decrypt the wallet exposes).
 * Two seed-derived identities talk to each other; NIP-44 v2 + legacy NIP-04 both
 * round-trip, and NIP-44 is the interop baseline with Goblin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveNostrIdentity } from '../identity';
import { nip44Encrypt, nip44Decrypt, nip04Encrypt, nip04Decrypt } from '../nip07';

const M = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const alice = deriveNostrIdentity(M, 0);
const bob = deriveNostrIdentity(M, 1);
const MSG = 'gm — 0.5 GRIN for the widget, order MM-deadbeef 🍄';

test('NIP-44 v2 round-trips between two identities', () => {
  const ct = nip44Encrypt(alice, bob.pubkeyHex, MSG);
  assert.notEqual(ct, MSG);
  // Bob decrypts with alice's pubkey (ECDH is symmetric).
  assert.equal(nip44Decrypt(bob, alice.pubkeyHex, ct), MSG);
  // Alice can read her own sent message back too.
  assert.equal(nip44Decrypt(alice, bob.pubkeyHex, ct), MSG);
});

test('legacy NIP-04 round-trips', () => {
  const ct = nip04Encrypt(alice, bob.pubkeyHex, MSG);
  assert.notEqual(ct, MSG);
  assert.equal(nip04Decrypt(bob, alice.pubkeyHex, ct), MSG);
});

test('a wrong-key decrypt does not return the plaintext', () => {
  const eve = deriveNostrIdentity(M, 7);
  const ct = nip44Encrypt(alice, bob.pubkeyHex, MSG);
  // Eve using her own key against alice's pubkey derives a different conversation
  // key → either throws (bad MAC) or yields non-plaintext; never the message.
  let leaked = false;
  try {
    leaked = nip44Decrypt(eve, alice.pubkeyHex, ct) === MSG;
  } catch {
    leaked = false;
  }
  assert.equal(leaked, false);
});
