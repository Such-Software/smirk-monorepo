/**
 * App-scoped e2ee X25519 derivation KAT. Pins the derivation so it can NEVER
 * drift (a changed key = every dapp's encrypted data orphaned). Locks: the golden
 * path + pubkey for a fixed vector, determinism, origin + context separation, and
 * disjointness from the Nostr identity key.
 *
 * NOTE: `appSealOpen` (libsodium crypto_box_seal open) is not yet implemented —
 * it needs a cross-impl KAT vs libsodium.js (next stage). This file locks the
 * recovery-critical derivation only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveAppEncryptionKey, appEncPath, APP_ENC_SCHEME } from '../app-enc';
import { deriveNostrIdentity } from '../identity';

const M = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const ORIGIN = 'https://idp.wowne.ro';
const CONTEXT = 'sso';

test('golden vector: fixed seed+origin+context → fixed path + x25519 pubkey', () => {
  const k = deriveAppEncryptionKey(M, ORIGIN, CONTEXT);
  assert.equal(k.path, "m/83696'/3'/267436374'/1723877227'/1182272911'");
  assert.equal(
    k.publicKeyHex,
    '2333879b34b781867619c329f1669bd131a884bd315c957b9d1e46ff701d9545',
  );
  assert.equal(k.privateKey.length, 32);
  assert.equal(APP_ENC_SCHEME, 'x25519-sealedbox');
  // Path is on the BIP-85 app-encryption branch (83696'/3'), all hardened.
  assert.match(k.path, /^m\/83696'\/3'\/\d+'\/\d+'\/\d+'$/);
});

test('deterministic across calls (recoverable from seed)', () => {
  const a = deriveAppEncryptionKey(M, ORIGIN, CONTEXT);
  const b = deriveAppEncryptionKey(M, ORIGIN, CONTEXT);
  assert.equal(a.publicKeyHex, b.publicKeyHex);
  assert.deepEqual(a.privateKey, b.privateKey);
});

test('domain-separated: different origin OR context → different key', () => {
  const base = deriveAppEncryptionKey(M, ORIGIN, CONTEXT).publicKeyHex;
  assert.notEqual(base, deriveAppEncryptionKey(M, 'https://nodebb.wowne.ro', CONTEXT).publicKeyHex);
  assert.notEqual(base, deriveAppEncryptionKey(M, ORIGIN, '').publicKeyHex);
  assert.notEqual(base, deriveAppEncryptionKey(M, ORIGIN, 'other').publicKeyHex);
  // appEncPath alone reflects the separation (indices differ).
  assert.notEqual(appEncPath(ORIGIN, CONTEXT), appEncPath(ORIGIN, ''));
});

test('independent of the Nostr identity key (different curve + path)', () => {
  const enc = deriveAppEncryptionKey(M, ORIGIN, CONTEXT).publicKeyHex;
  assert.notEqual(enc, deriveNostrIdentity(M, 0).pubkeyHex);
  // Rotating the npub (account 1) does not change the encryption key.
  assert.equal(
    deriveAppEncryptionKey(M, ORIGIN, CONTEXT).publicKeyHex,
    '2333879b34b781867619c329f1669bd131a884bd315c957b9d1e46ff701d9545',
  );
});

test('domainScope is required (handler must supply the verified origin)', () => {
  assert.throws(() => deriveAppEncryptionKey(M, ''), /domainScope is required/);
});
