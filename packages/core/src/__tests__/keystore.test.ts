/**
 * Keystore tests: round-trip encrypt/decrypt, wrong-password rejection,
 * fingerprint stability, address derivation, state-machine transitions.
 *
 * These tests use a fixed BIP39 mnemonic (the Trezor test vector — public
 * value, no real funds) plus a low PBKDF2 iteration count so the test
 * suite stays fast. Production uses 600_000 iterations; the iteration
 * count is configurable on `createKeystore` so we can drop it for tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryStorage,
  InvalidPasswordError,
  KEYSTORE_VERSION,
  WalletKeystore,
  WalletLockedError,
  computeSeedFingerprint,
  createKeystore,
  deriveAddresses,
  deriveAllKeys,
  isValidGrinSlatepackAddress,
  isValidLtcAddress,
  isValidXmrAddress,
  isValidWowAddress,
  unlockKeystore,
} from '../index';

// Public test vector from Trezor's BIP39 reference. Has been public for years
// and never funded. Safe to commit.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const FAST_ITERS = 1_000;

// ============================================================================
// Pure functions
// ============================================================================

test('createKeystore + unlockKeystore: round-trip recovers the mnemonic', async () => {
  const ks = await createKeystore(TEST_MNEMONIC, 'hunter2', FAST_ITERS);
  assert.equal(ks.version, KEYSTORE_VERSION);
  assert.equal(ks.iterations, FAST_ITERS);
  assert.equal(ks.fingerprint, computeSeedFingerprint(TEST_MNEMONIC));

  const unlocked = await unlockKeystore(ks, 'hunter2');
  assert.equal(unlocked.mnemonic, TEST_MNEMONIC);
  assert.equal(unlocked.fingerprint, ks.fingerprint);
});

test('unlockKeystore: wrong password throws InvalidPasswordError', async () => {
  const ks = await createKeystore(TEST_MNEMONIC, 'hunter2', FAST_ITERS);
  await assert.rejects(unlockKeystore(ks, 'wrong'), InvalidPasswordError);
});

test('createKeystore: rejects invalid mnemonic', async () => {
  await assert.rejects(
    createKeystore('not a real mnemonic', 'p', FAST_ITERS),
    /Invalid mnemonic/,
  );
});

test('createKeystore: rejects empty password', async () => {
  await assert.rejects(
    createKeystore(TEST_MNEMONIC, '', FAST_ITERS),
    /non-empty/,
  );
});

test('createKeystore: distinct salt + ciphertext on each call', async () => {
  const a = await createKeystore(TEST_MNEMONIC, 'p', FAST_ITERS);
  const b = await createKeystore(TEST_MNEMONIC, 'p', FAST_ITERS);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.encryptedMnemonic, b.encryptedMnemonic);
  // ...but same fingerprint, since the underlying mnemonic is the same.
  assert.equal(a.fingerprint, b.fingerprint);
});

test('unlockKeystore: rejects keystore with wrong version', async () => {
  const ks = await createKeystore(TEST_MNEMONIC, 'p', FAST_ITERS);
  await assert.rejects(
    unlockKeystore({ ...ks, version: 99 }, 'p'),
    /Unsupported keystore version/,
  );
});

// ============================================================================
// Address derivation
// ============================================================================

test('deriveAddresses: produces validator-passing addresses for every asset', () => {
  const keys = deriveAllKeys(TEST_MNEMONIC, '', 3);
  const addrs = deriveAddresses(keys);
  assert.match(addrs.btc, /^bc1/);
  assert.equal(isValidLtcAddress(addrs.ltc), true);
  assert.equal(isValidXmrAddress(addrs.xmr), true);
  assert.equal(isValidWowAddress(addrs.wow), true);
  assert.equal(isValidGrinSlatepackAddress(addrs.grin), true);
});

// ============================================================================
// WalletKeystore state machine
// ============================================================================

test('WalletKeystore: empty → unlocked via createWallet', async () => {
  const wk = new WalletKeystore(new InMemoryStorage());

  const before = await wk.getState();
  assert.equal(before.kind, 'empty');

  const wallet = await wk.createWallet({
    mnemonic: TEST_MNEMONIC,
    password: 'hunter2',
    iterations: FAST_ITERS,
  });
  assert.equal(wallet.mnemonic, TEST_MNEMONIC);

  const after = await wk.getState();
  assert.equal(after.kind, 'unlocked');
  if (after.kind === 'unlocked') {
    assert.equal(after.wallet.fingerprint, wallet.fingerprint);
  }
});

test('WalletKeystore: createWallet refuses to overwrite existing keystore', async () => {
  const wk = new WalletKeystore(new InMemoryStorage());
  await wk.createWallet({ mnemonic: TEST_MNEMONIC, password: 'p', iterations: FAST_ITERS });
  await assert.rejects(
    wk.createWallet({ mnemonic: TEST_MNEMONIC, password: 'p', iterations: FAST_ITERS }),
    /already exists/,
  );
});

test('WalletKeystore: lock → unlocked state cleared, on-disk keystore preserved', async () => {
  const wk = new WalletKeystore(new InMemoryStorage());
  await wk.createWallet({ mnemonic: TEST_MNEMONIC, password: 'p', iterations: FAST_ITERS });
  await wk.lock();

  const state = await wk.getState();
  assert.equal(state.kind, 'locked');

  assert.throws(() => wk.getUnlocked(), WalletLockedError);
});

test('WalletKeystore: locked → unlocked via unlock(password)', async () => {
  const storage = new InMemoryStorage();
  const wk1 = new WalletKeystore(storage);
  await wk1.createWallet({ mnemonic: TEST_MNEMONIC, password: 'p', iterations: FAST_ITERS });

  // Simulate SW restart: fresh WalletKeystore reading from same storage.
  const wk2 = new WalletKeystore(storage);
  const before = await wk2.getState();
  assert.equal(before.kind, 'locked');

  const wallet = await wk2.unlock('p');
  assert.equal(wallet.mnemonic, TEST_MNEMONIC);
  assert.equal((await wk2.getState()).kind, 'unlocked');
});

test('WalletKeystore: unlock with wrong password throws and leaves state locked', async () => {
  const storage = new InMemoryStorage();
  const wk = new WalletKeystore(storage);
  await wk.createWallet({ mnemonic: TEST_MNEMONIC, password: 'p', iterations: FAST_ITERS });
  await wk.lock();

  await assert.rejects(wk.unlock('wrong'), InvalidPasswordError);
  assert.equal((await wk.getState()).kind, 'locked');
});

test('WalletKeystore: destroy wipes the keystore from storage', async () => {
  const wk = new WalletKeystore(new InMemoryStorage());
  await wk.createWallet({ mnemonic: TEST_MNEMONIC, password: 'p', iterations: FAST_ITERS });
  await wk.destroy();
  assert.equal((await wk.getState()).kind, 'empty');
});

test('WalletKeystore: cross-instance via shared storage (popup ↔ pop-out scenario)', async () => {
  const storage = new InMemoryStorage();
  const a = new WalletKeystore(storage);
  await a.createWallet({ mnemonic: TEST_MNEMONIC, password: 'p', iterations: FAST_ITERS });

  // Second instance sees the keystore (locked, since it doesn't share
  // the in-memory cache with `a`).
  const b = new WalletKeystore(storage);
  const stateB = await b.getState();
  assert.equal(stateB.kind, 'locked');
  await b.unlock('p');
  assert.equal((await b.getState()).kind, 'unlocked');
});
