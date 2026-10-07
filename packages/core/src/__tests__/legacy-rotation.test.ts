/**
 * Pre-v0.3 identity carry-over: the rotation proof a returning wallet sends so
 * the backend can move a `migrate-legacy` row (identity on the `m/44'` BTC key,
 * no key rows) onto the v0.3 `m/84'` key.
 *
 * Fixture: the standard BIP39 test vector phrase, never a real wallet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

import {
  bitcoinMessageHash,
  bytesToHex,
  deriveAllKeys,
  deriveLegacyBtcLtcKey,
  legacyBtcRotationProof,
  mnemonicToSeed,
  rotationMessage,
} from '../index';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const API = 'https://api.smirk.cash/api/v1';

test('rotation message matches the backend format byte for byte', () => {
  const newKey = '02' + '11'.repeat(32);
  const hash = bytesToHex(sha256(new TextEncoder().encode(newKey)));
  assert.equal(
    rotationMessage(`${API}/`, newKey, 1_790_000_000),
    `smirk-rotate-v1|${API}|${hash}|1790000000`,
  );
});

test('the proof is made by the pre-v0.3 m/44 key and verifies under it', () => {
  const seed = mnemonicToSeed(PHRASE);
  const v3 = deriveAllKeys(PHRASE, '', 3);
  const newKey = bytesToHex(v3.btc.publicKey);
  const legacy = deriveLegacyBtcLtcKey(seed, 0);
  const ts = 1_790_000_000;

  const proof = legacyBtcRotationProof(seed, newKey, ts, API);
  assert.ok(proof, 'v0.3 and pre-v0.3 BTC keys differ, so a proof is produced');
  assert.equal(proof.rotationPublicKey, bytesToHex(legacy.publicKey));
  assert.notEqual(proof.rotationPublicKey, newKey);

  const sig = Uint8Array.from(atob(proof.rotationSignature), (c) => c.charCodeAt(0));
  assert.equal(sig.length, 65);
  const digest = bitcoinMessageHash(rotationMessage(API, newKey, ts));
  assert.ok(
    secp256k1.verify(sig.slice(1), digest, legacy.publicKey),
    'signature verifies under the legacy key',
  );
  assert.ok(
    !secp256k1.verify(sig.slice(1), digest, v3.btc.publicKey),
    'and not under the v0.3 key',
  );
});

test('no proof when the old and new keys coincide', () => {
  const seed = mnemonicToSeed(PHRASE);
  const legacyHex = bytesToHex(deriveLegacyBtcLtcKey(seed, 0).publicKey);
  assert.equal(legacyBtcRotationProof(seed, legacyHex, 1, API), null);
});
