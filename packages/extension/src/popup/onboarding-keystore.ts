/**
 * Resolve the keystore for an onboarding attempt that may be a RETRY.
 *
 * Onboarding's durable write (`createWallet`) happens BEFORE registration,
 * which is network work: PoW, then a signed register call. When registration
 * loses, the seed is already sealed on disk under the password of that first
 * attempt, and the wizard drops the user back on "Set a password" with the
 * backend's error printed under the password fields.
 *
 * 2026-09-09 incident: a machine whose clock was far enough off
 * failed the NIP-98 register on every attempt (the backend validates the
 * client-signed event against a short window), and the error it printed
 * under the password fields was "Invalid Nostr proof". Reading a
 * cryptographic-sounding rejection under a password box, the user did the
 * obvious thing: they tried a different password. From that point on the
 * resume path (added in 7bcf2f0, which unlocks an existing keystore rather
 * than recreating it) answered "Invalid password" to every attempt, because
 * the seed was sealed under the FIRST password. The lock screen offers no way
 * past that, so the wallet was unreachable on a machine whose only fault was a
 * wrong clock.
 *
 * The seed is the wallet. When the keystore on disk holds the SAME seed the
 * user is onboarding with, we are holding that mnemonic in hand, so re-sealing
 * it under the password they just typed costs nothing: same seed, same keys,
 * same fingerprint, only the password binding changes.
 *
 * A keystore holding a DIFFERENT seed is never overwritten here, and never
 * unlocked either. Unlocking it is the worse failure: the password matches, so
 * onboarding would carry on with the OLD seed while the phrase the user just
 * wrote down belongs to a different wallet, with nothing on screen saying so.
 * That is what this code did before, despite the resume path's claim that a
 * different seed "fails loudly": `unlock` checks the password, never the seed.
 */

import { InvalidPasswordError, computeSeedFingerprint } from '@smirk/core';
import type { UnlockedWallet, WalletState } from '@smirk/core';

/**
 * The slice of `WalletKeystore` this needs. Structural so tests can drive the
 * branching against a real keystore at a test iteration count.
 */
export interface OnboardingKeystore {
  getState(): Promise<WalletState>;
  createWallet(args: { mnemonic: string; password: string }): Promise<UnlockedWallet>;
  unlock(password: string): Promise<UnlockedWallet>;
  destroy(): Promise<void>;
}

/**
 * Shown when the device already holds a keystore for a DIFFERENT seed, which in
 * practice means the user went back mid-onboarding and generated or imported a
 * second phrase after the first one was already sealed. We refuse rather than
 * pick one for them: the wallet on disk is reachable with the password from
 * that earlier attempt, and destroying it here would take away the only local
 * copy of a wallet whose phrase they may no longer have on screen.
 */
export const ONBOARDING_SEED_MISMATCH_MESSAGE =
  'A different wallet is already saved on this device from an earlier attempt. ' +
  'Close and reopen Smirk to unlock it with the password you set then.';

/**
 * `instanceof` fails if two copies of @smirk/core ever end up in one bundle, and
 * the cost of missing this is the incident itself: we would rethrow and put the
 * user back on "Invalid password". Read the name off a real instance rather than
 * off the constructor, which a minifier may rename.
 */
const WRONG_PASSWORD_NAME = new InvalidPasswordError().name;

function isWrongPassword(e: unknown): boolean {
  return (
    e instanceof InvalidPasswordError ||
    (e instanceof Error && e.name === WRONG_PASSWORD_NAME)
  );
}

/**
 * Return the unlocked wallet for `mnemonic`, creating, resuming, or re-sealing
 * the on-disk keystore as needed. Never touches a keystore holding another seed.
 *
 * @throws when a keystore for a different seed exists (nothing is written).
 */
export async function openOrCreateOnboardingWallet(
  keystore: OnboardingKeystore,
  mnemonic: string,
  password: string,
): Promise<UnlockedWallet> {
  const existing = await keystore.getState();
  if (existing.kind === 'empty') {
    return keystore.createWallet({ mnemonic, password });
  }
  if (existing.keystore.fingerprint !== computeSeedFingerprint(mnemonic)) {
    throw new Error(ONBOARDING_SEED_MISMATCH_MESSAGE);
  }
  try {
    // Same seed, same password: this is the same wallet, so resume it rather
    // than pay to re-encrypt what is already there.
    return await keystore.unlock(password);
  } catch (e) {
    if (!isWrongPassword(e)) throw e;
    // Same seed, different password: re-seal. A crash between these two lines
    // leaves NO keystore, which is a clean retry of a wallet whose phrase the
    // user has just verified or pasted, not a wallet they cannot open. Both are
    // recoverable; only the second one strands them.
    await keystore.destroy();
    return keystore.createWallet({ mnemonic, password });
  }
}
