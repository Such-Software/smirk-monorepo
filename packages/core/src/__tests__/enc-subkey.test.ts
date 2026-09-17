import test from 'node:test';
import assert from 'node:assert/strict';

import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex } from '@noble/hashes/utils';

import { deriveAllKeys, deriveEncryptionKey, mnemonicToSeed } from '../hd';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('the encryption subkey is a standard ed25519 keypair, not a reduced scalar', () => {
  // Load-bearing: age derives its X25519 secret as SHA512(seed)[0..32] and that
  // only pairs with a public key formed the standard way. A CryptoNote-style
  // derivation (reduce mod L, multiply BASE) would produce a key no age
  // implementation can talk to.
  const k = deriveEncryptionKey(mnemonicToSeed(MNEMONIC, ''), 'xmr');
  assert.equal(k.seed.length, 32);
  assert.equal(k.publicKey.length, 32);
  assert.deepEqual(k.publicKey, ed25519.getPublicKey(k.seed));
});

test('each asset gets a different encryption subkey', () => {
  // Per-asset, so xmr and wow rotate independently.
  const seed = mnemonicToSeed(MNEMONIC, '');
  const xmr = deriveEncryptionKey(seed, 'xmr');
  const wow = deriveEncryptionKey(seed, 'wow');
  assert.notDeepEqual(xmr.seed, wow.seed);
  assert.notDeepEqual(xmr.publicKey, wow.publicKey);
});

test('the encryption subkey is never the spend key or any other wallet key', () => {
  // The entire reason this key exists. If it ever equals the spend key, the
  // separation that motivates it is gone.
  const keys = deriveAllKeys(MNEMONIC, '', 3);
  const enc = [keys.enc.xmr, keys.enc.wow];
  const others = [
    keys.xmr.privateSpendKey,
    keys.xmr.privateViewKey,
    keys.xmr.publicSpendKey,
    keys.wow.privateSpendKey,
    keys.wow.privateViewKey,
    keys.wow.publicSpendKey,
    keys.grin.privateKey,
    keys.grin.publicKey,
    keys.btc.privateKey,
    keys.ltc.privateKey,
    keys.nostr.privateKey,
  ].map(bytesToHex);

  for (const e of enc) {
    assert.ok(!others.includes(bytesToHex(e.seed)), 'enc seed collides with another key');
    assert.ok(!others.includes(bytesToHex(e.publicKey)), 'enc pubkey collides with another key');
  }
});

test('derivation is deterministic and independent of the BTC derivation version', () => {
  // A wallet's encryption identity must not move when the spend-key path does,
  // or an old tip stops opening after an unrelated upgrade.
  const v1 = deriveAllKeys(MNEMONIC, '', 1);
  const v2 = deriveAllKeys(MNEMONIC, '', 2);
  const v3 = deriveAllKeys(MNEMONIC, '', 3);
  assert.deepEqual(v1.enc.xmr.publicKey, v3.enc.xmr.publicKey);
  assert.deepEqual(v2.enc.wow.publicKey, v3.enc.wow.publicKey);
  assert.deepEqual(deriveAllKeys(MNEMONIC, '', 3).enc.xmr.seed, v3.enc.xmr.seed);
});

test('a different mnemonic yields a different encryption subkey', () => {
  const other =
    'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
  assert.notDeepEqual(
    deriveAllKeys(MNEMONIC, '', 3).enc.xmr.publicKey,
    deriveAllKeys(other, '', 3).enc.xmr.publicKey,
  );
});
