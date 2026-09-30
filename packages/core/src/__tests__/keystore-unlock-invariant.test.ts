import { generateMnemonicPhrase } from '../hd';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WalletKeystore, hasCompleteSigningMaterial, restoreUnlockedFromCache } from '../keystore';
import { InMemoryStorage } from '../state/platform';

// Runtime-only wallet material; no recovery phrase is checked in.
const MNEMONIC = generateMnemonicPhrase();
const PASSWORD = 'test-only-password';

async function fixture(storage = new InMemoryStorage()) {
  const keystore = new WalletKeystore(storage);
  const wallet = await keystore.createWallet({ mnemonic: MNEMONIC, password: PASSWORD, iterations: 1_000 });
  return { storage, keystore, wallet };
}

test('creation and password unlock supply complete signing material', async () => {
  const { keystore, wallet } = await fixture();
  assert.ok(hasCompleteSigningMaterial(wallet));
  await keystore.lock();
  const reopened = await keystore.unlock(PASSWORD);
  assert.ok(hasCompleteSigningMaterial(reopened));
  assert.equal((await keystore.getState()).kind, 'unlocked');
});

test('a legacy partial cache cannot establish an unlocked keystore', async () => {
  const { keystore, wallet } = await fixture();
  const partial = restoreUnlockedFromCache(wallet);
  (keystore as unknown as { cached: typeof partial }).cached = partial;
  assert.equal((await keystore.getState()).kind, 'locked');
  assert.throws(() => keystore.getUnlocked());
});

test('lock revokes shared wallet references and all cached secret buffers', async () => {
  const { keystore, wallet } = await fixture();
  const seed = wallet.seed!;
  const secrets = [
    wallet.keys.btc.privateKey, wallet.keys.ltc.privateKey,
    wallet.keys.xmr.privateSpendKey, wallet.keys.xmr.privateViewKey,
    wallet.keys.wow.privateSpendKey, wallet.keys.wow.privateViewKey,
    wallet.keys.grin.privateKey, wallet.keys.nostr.privateKey,
    wallet.keys.enc.xmr.seed, wallet.keys.enc.wow.seed,
  ];
  await keystore.lock();
  assert.ok(seed.every((byte) => byte === 0));
  assert.ok(secrets.every((bytes) => bytes.every((byte) => byte === 0)));
  assert.ok(wallet.mnemonic === undefined);
  assert.ok(wallet.seed === undefined);
  assert.equal(hasCompleteSigningMaterial(wallet), false);
  assert.throws(() => keystore.getUnlocked());
});

test('a missing key family refuses unlocked state before any operation starts', async () => {
  const { keystore, wallet } = await fixture();
  wallet.keys.enc.xmr.seed.fill(0);
  assert.equal(hasCompleteSigningMaterial(wallet), false);
  assert.equal((await keystore.getState()).kind, 'locked');
});

test('explicit lock wins over password unlock already in flight', async () => {
  class GatedStorage extends InMemoryStorage {
    gate: Promise<void> | null = null;
    override async get<T>(key: string): Promise<T | null> {
      if (this.gate) await this.gate;
      return super.get<T>(key);
    }
  }
  const storage = new GatedStorage();
  const { keystore } = await fixture(storage);
  await keystore.lock();
  let release!: () => void;
  storage.gate = new Promise((resolve) => { release = resolve; });
  const unlocking = keystore.unlock(PASSWORD);
  await keystore.lock();
  release();
  await assert.rejects(unlocking, (error: unknown) => error instanceof Error && error.message.length > 0);
  assert.equal((await keystore.getState()).kind, 'locked');
});

test('operation password verification preserves the exact session and grace deadline', async () => {
  const { keystore, wallet } = await fixture();
  const expiry = Date.now() + 3_600_000;
  wallet.sessionExpiresAtMs = expiry;
  await keystore.verifyPassword(PASSWORD, wallet);
  assert.ok(keystore.getUnlocked() === wallet);
  assert.equal(wallet.sessionExpiresAtMs, expiry);
  await assert.rejects(() => keystore.verifyPassword('wrong-test-password', wallet));
  assert.ok(keystore.getUnlocked() === wallet);
  assert.equal(wallet.sessionExpiresAtMs, expiry);
});

test('an operation approval cannot cross a lock and subsequent unlock', async () => {
  const { keystore, wallet } = await fixture();
  await keystore.lock();
  await keystore.unlock(PASSWORD);
  assert.throws(() => keystore.assertUnlockedWallet(wallet));
  await assert.rejects(() => keystore.verifyPassword(PASSWORD, wallet));
});

test('locking during operation password verification refuses without reopening the wallet', async () => {
  const { keystore, wallet } = await fixture();
  const verification = keystore.verifyPassword(PASSWORD, wallet);
  await keystore.lock();
  await assert.rejects(verification);
  assert.equal((await keystore.getState()).kind, 'locked');
});

test('recovery phrase reveal keeps the original signing session and expiry', async () => {
  const { keystore, wallet } = await fixture();
  const expiry = Date.now() + 14_400_000;
  wallet.sessionExpiresAtMs = expiry;
  const phrase = await keystore.readRecoveryPhrase(PASSWORD, wallet);
  assert.ok(phrase === MNEMONIC);
  assert.ok(keystore.getUnlocked() === wallet);
  assert.equal(wallet.sessionExpiresAtMs, expiry);
  await assert.rejects(keystore.readRecoveryPhrase('wrong-test-password', wallet));
  assert.ok(keystore.getUnlocked() === wallet);
});

test('a lock during password verification prevents phrase reveal and session resurrection', async () => {
  const { keystore, wallet } = await fixture();
  const revealing = keystore.readRecoveryPhrase(PASSWORD, wallet);
  await keystore.lock();
  await assert.rejects(revealing);
  assert.equal((await keystore.getState()).kind, 'locked');
});
