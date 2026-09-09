/**
 * Onboarding must not seal a wallet the user can no longer open.
 *
 * Reported from real use on 2026-09-09, on a machine with a clock more than 30
 * seconds off: registration failed on every attempt (the backend rejects a
 * signed action outside a 30 second window) and the wizard printed its error
 * under the password fields. The seed was already sealed by then, so when the
 * user answered a cryptographic-sounding error by choosing a different
 * password, every attempt after that reported "invalid password" for a password
 * they had just typed twice.
 *
 * These tests pin the three cases the retry can arrive in. The one that must
 * never regress is the last: a keystore holding a DIFFERENT seed is neither
 * overwritten nor unlocked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryStorage,
  WalletKeystore,
  computeSeedFingerprint,
} from '@smirk/core';

import {
  openOrCreateOnboardingWallet,
  type OnboardingKeystore,
} from '../onboarding-keystore';

// Public BIP39 reference vectors (Trezor). Public for years, never funded.
const SEED_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED_B =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

// The production KDF cost is core's business (keystore.test.ts covers it) and
// only slows this suite down, so the subject injects a test iteration count.
const FAST_ITERS = 1_000;

function subject() {
  const ks = new WalletKeystore(new InMemoryStorage());
  const adapter: OnboardingKeystore = {
    getState: () => ks.getState(),
    unlock: (p) => ks.unlock(p),
    destroy: () => ks.destroy(),
    createWallet: (args) => ks.createWallet({ ...args, iterations: FAST_ITERS }),
  };
  return { ks, adapter };
}

test('a first attempt seals the seed the user is onboarding with', async () => {
  const { adapter } = subject();
  const wallet = await openOrCreateOnboardingWallet(adapter, SEED_A, 'pw-one-12345');
  assert.equal(wallet.fingerprint, computeSeedFingerprint(SEED_A));
});

test('a retry with the same password resumes the wallet already sealed', async () => {
  const { ks, adapter } = subject();
  const first = await openOrCreateOnboardingWallet(adapter, SEED_A, 'pw-one-12345');
  const before = await ks.getState();

  const again = await openOrCreateOnboardingWallet(adapter, SEED_A, 'pw-one-12345');
  assert.equal(again.fingerprint, first.fingerprint);

  // Resumed, not re-sealed: the stored keystore is the same object it was.
  const after = await ks.getState();
  assert.deepEqual(
    after.kind !== 'empty' ? after.keystore : null,
    before.kind !== 'empty' ? before.keystore : null,
  );
});

test('a retry with a different password re-seals the same seed under it', async () => {
  const { ks, adapter } = subject();
  const first = await openOrCreateOnboardingWallet(adapter, SEED_A, 'pw-one-12345');

  // This is the incident: the register error rendered under the password
  // fields, so the user changed the password.
  const second = await openOrCreateOnboardingWallet(adapter, SEED_A, 'pw-two-67890');

  // Same wallet, no seed lost.
  assert.equal(second.fingerprint, first.fingerprint);
  assert.deepEqual(second.addresses, first.addresses);

  // And the password the user just chose is the one that opens it, both now and
  // at the lock screen after a restart.
  await ks.lock();
  const reopened = await ks.unlock('pw-two-67890');
  assert.equal(reopened.fingerprint, first.fingerprint);
});

test('a keystore holding a different seed is neither unlocked nor overwritten', async () => {
  const { ks, adapter } = subject();
  await openOrCreateOnboardingWallet(adapter, SEED_A, 'same-password-1');
  const before = await ks.getState();

  // Same password, different phrase: unlocking would SUCCEED and hand back the
  // wallet for SEED_A while the user holds the phrase for SEED_B.
  await assert.rejects(
    () => openOrCreateOnboardingWallet(adapter, SEED_B, 'same-password-1'),
    (e: unknown) => e instanceof Error && e.message.length > 0,
  );

  const after = await ks.getState();
  assert.deepEqual(
    after.kind !== 'empty' ? after.keystore : null,
    before.kind !== 'empty' ? before.keystore : null,
    'the wallet already on disk must survive an attempt with another seed',
  );
  assert.equal(
    after.kind !== 'empty' && after.keystore.fingerprint,
    computeSeedFingerprint(SEED_A),
  );
});
