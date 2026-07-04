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

// Frozen blobs produced by the ACTUAL deployed v0.2.4 encryptor (smirk-extension
// working tree == v0.2.4 tag, 0 diff) sealing MNEMONIC with PASSWORD. The
// SHIP-GATE: v0.3 must reproduce the mnemonic from REAL v0.2.4 output, not just a
// core round-trip. Regenerate via encryptPrivateKey in smirk-extension src/lib/crypto.ts.
const REAL_V024 = {
  // sealed at 100000 iters; pbkdf2Iterations ABSENT ⇒ decrypt defaults to 100000
  cohort100k: {
    encryptedSeed:
      '634f7967039c8c116290e0f0877c51c7cbf3fc2e883224c250a0da28c359e63887c27a3944c423142770bd99694d94387595b39cede9359a68c53de0336db6e817a1c93ffc3e52c6fb36c93805745adfbce95734c3d172906382f55ce8989429f6cc928d958799ada2da4d0ef79d35eeb5da0a',
    seedSalt: 'e336567779e04205cacb274036173fd0',
  },
  // sealed at 600000 iters
  cohort600k: {
    encryptedSeed:
      '2b34c65abdfb7c08c44038ce1cbbdc21a157e8ee561316ee7b78a48913501fb192f2bc6cfc5ab3b68efbbf0b5c4f5ba978a15092023b7cea3f755c325aa8ca4291508e67e822a483a42bc370f0b0e47e4acba5556f11640b98c68ad094efd6d0a51376822fd6a38502d722320cad44e9a12997',
    seedSalt: '76d64d0de381982d9b5c2268a7896a17',
  },
} as const;

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

test('SHIP-GATE — decrypt a REAL v0.2.4-encoded blob (600k)', async () => {
  const legacy: LegacyWalletState = {
    ...REAL_V024.cohort600k,
    pbkdf2Iterations: 600_000,
  };
  assert.equal(await decryptLegacyMnemonic(legacy, PASSWORD), MNEMONIC);
});

test('SHIP-GATE — decrypt a REAL v0.2.4-encoded blob (100k, iterations absent)', async () => {
  const legacy: LegacyWalletState = { ...REAL_V024.cohort100k };
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
