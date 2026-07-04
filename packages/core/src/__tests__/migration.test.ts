import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encryptPrivateKey } from '../crypto';
import {
  decryptLegacyMnemonic,
  detectLegacyWallet,
  legacyBtcLtcKey,
  LEGACY_WALLET_KEY,
  V03_KEYSTORE_KEY,
  type LegacyWalletState,
} from '../migration';
import { InMemoryStorage } from '../state/platform';

// A well-known BIP-39 test mnemonic (Trezor vector) — NOT a funded wallet.
const MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSWORD = 'correct horse battery staple';

/**
 * Seal the mnemonic PHRASE bytes exactly as v0.2.x did: XChaCha20-Poly1305 with
 * a PBKDF2-SHA256 key. core `encryptPrivateKey` is byte-identical to the legacy
 * seal (verified), so this produces a genuine v0.2-format `walletState` blob —
 * the KAT then proves the v0.3 decryptor reproduces the mnemonic. Swap in a REAL
 * exported v0.2.4 blob here for the final ship-gate check.
 */
async function sealLikeV02(mnemonic: string, password: string, iterations: number) {
  const { encrypted, salt } = await encryptPrivateKey(
    new TextEncoder().encode(mnemonic),
    password,
    iterations,
  );
  return { encryptedSeed: encrypted, seedSalt: salt };
}

test('decrypt KAT — 600k cohort (pbkdf2Iterations stored)', async () => {
  const s = await sealLikeV02(MNEMONIC, PASSWORD, 600_000);
  const legacy: LegacyWalletState = { ...s, pbkdf2Iterations: 600_000 };
  assert.equal(await decryptLegacyMnemonic(legacy, PASSWORD), MNEMONIC);
});

test('decrypt KAT — 100k legacy cohort (pbkdf2Iterations ABSENT ⇒ 100000)', async () => {
  const s = await sealLikeV02(MNEMONIC, PASSWORD, 100_000);
  // pbkdf2Iterations intentionally absent — decrypt MUST default to 100000.
  const legacy: LegacyWalletState = { ...s };
  assert.equal(await decryptLegacyMnemonic(legacy, PASSWORD), MNEMONIC);
});

test('decrypt — wrong password throws (AEAD tag verify)', async () => {
  const s = await sealLikeV02(MNEMONIC, PASSWORD, 600_000);
  const legacy: LegacyWalletState = { ...s, pbkdf2Iterations: 600_000 };
  await assert.rejects(() => decryptLegacyMnemonic(legacy, 'wrong password'));
});

test('decrypt — wrong iterations (600k blob read as 100k) throws', async () => {
  const s = await sealLikeV02(MNEMONIC, PASSWORD, 600_000);
  // Blob sealed at 600k but no stored count ⇒ decrypt tries 100k ⇒ wrong key ⇒ throw.
  const legacy: LegacyWalletState = { ...s };
  await assert.rejects(() => decryptLegacyMnemonic(legacy, PASSWORD));
});

test('legacyBtcLtcKey — m/44 P2WPKH address (bc1q/ltc1q), 32-byte key', () => {
  const btc = legacyBtcLtcKey(MNEMONIC, 'btc');
  const ltc = legacyBtcLtcKey(MNEMONIC, 'ltc');
  assert.match(btc.address, /^bc1q/);
  assert.match(ltc.address, /^ltc1q/);
  assert.equal(btc.privateKey.length, 32);
  // The whole point of the sweep: the m/44 address differs from what a v0.3
  // (m/84) wallet watches, so the two are not equal.
  assert.notEqual(btc.address, ltc.address);
});

test('detectLegacyWallet — true only with legacy seed AND no v0.3 keystore', async () => {
  const storage = new InMemoryStorage();
  assert.equal(await detectLegacyWallet(storage), false);
  await storage.set(LEGACY_WALLET_KEY, { encryptedSeed: 'ab', seedSalt: 'cd' });
  assert.equal(await detectLegacyWallet(storage), true);
  await storage.set(V03_KEYSTORE_KEY, { version: 1 });
  assert.equal(await detectLegacyWallet(storage), false); // already migrated
});
