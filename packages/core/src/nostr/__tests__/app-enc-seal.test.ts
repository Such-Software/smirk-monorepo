/**
 * Cross-impl KAT for the dapp e2ee open path. libsodium (the reference) SEALS;
 * our `@noble`-only `sealOpen` / `appSealOpen` OPENS. This is the contract that
 * lets a dapp seal to the wallet's app pubkey with stock libsodium (offline, no
 * wallet call) and trust the wallet can read it back — byte-exact, forever.
 *
 * `crypto_box_seal` is anonymous: seal needs only the recipient pubkey; open needs
 * the secret key. A subtly-wrong `crypto_box` assembly fails the Poly1305 tag
 * rather than returning garbage, so a green round-trip here is a strong proof.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';

import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

import { deriveAppEncryptionKey, sealOpen, appSealOpen } from '../app-enc';

const M = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const ORIGIN = 'https://idp.wowne.ro';
const CONTEXT = 'sso';

const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

before(async () => {
  await sodium.ready;
});

test('libsodium crypto_box_seal → our sealOpen (pure primitive)', () => {
  const key = deriveAppEncryptionKey(M, ORIGIN, CONTEXT);
  const pub = hexToBytes(key.publicKeyHex);
  const msg = utf8('smirk app-scoped e2ee — hello from the dapp');

  const sealed = sodium.crypto_box_seal(msg, pub);
  const opened = sealOpen(key.privateKey, sealed);

  assert.equal(fromUtf8(opened), fromUtf8(msg));
  assert.equal(bytesToHex(opened), bytesToHex(msg));
});

test('high-level appSealOpen re-derives from the seed and opens', () => {
  const key = deriveAppEncryptionKey(M, ORIGIN, CONTEXT);
  const msg = utf8(JSON.stringify({ note: 'server-cannot-read', n: 42 }));

  const sealed = sodium.crypto_box_seal(msg, hexToBytes(key.publicKeyHex));
  const opened = appSealOpen(M, ORIGIN, sealed, CONTEXT);

  assert.deepEqual(Array.from(opened), Array.from(msg));
});

test('binary (non-utf8) payload round-trips byte-exact', () => {
  const key = deriveAppEncryptionKey(M, ORIGIN, CONTEXT);
  const msg = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe, 0x00, 0x00]);

  const sealed = sodium.crypto_box_seal(msg, hexToBytes(key.publicKeyHex));
  const opened = sealOpen(key.privateKey, sealed);

  assert.deepEqual(Array.from(opened), Array.from(msg));
});

test('empty plaintext round-trips (0-length payload)', () => {
  const key = deriveAppEncryptionKey(M, ORIGIN, CONTEXT);
  const sealed = sodium.crypto_box_seal(new Uint8Array(0), hexToBytes(key.publicKeyHex));
  const opened = sealOpen(key.privateKey, sealed);
  assert.equal(opened.length, 0);
});

test('tampered ciphertext is rejected (Poly1305 tag fails)', () => {
  const key = deriveAppEncryptionKey(M, ORIGIN, CONTEXT);
  const sealed = sodium.crypto_box_seal(utf8('integrity-protected'), hexToBytes(key.publicKeyHex));
  const tampered = sealed.slice();
  tampered[tampered.length - 1] ^= 0x01; // flip a ciphertext bit
  assert.throws(() => sealOpen(key.privateKey, tampered));
});

test('wrong recipient key cannot open (different context → different key)', () => {
  const key = deriveAppEncryptionKey(M, ORIGIN, CONTEXT);
  const other = deriveAppEncryptionKey(M, ORIGIN, 'different-context');
  const sealed = sodium.crypto_box_seal(utf8('addressed to sso only'), hexToBytes(key.publicKeyHex));
  assert.throws(() => sealOpen(other.privateKey, sealed));
});

test('a too-short envelope is rejected before any crypto', () => {
  const key = deriveAppEncryptionKey(M, ORIGIN, CONTEXT);
  assert.throws(() => sealOpen(key.privateKey, new Uint8Array(40)), /too short/);
});
