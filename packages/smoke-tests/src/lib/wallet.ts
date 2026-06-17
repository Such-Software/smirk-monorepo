/**
 * Smoke-test wallet booter.
 *
 * Constructs an `UnlockedWallet` from a raw BIP-39 mnemonic — no
 * password, no keystore encryption. We're driving server-side test
 * wallets whose mnemonics live in env vars; the password layer
 * exists in the production wallet to defend against device theft
 * and isn't useful here.
 *
 * The composition mirrors what `unlockKeystore` does internally
 * after the AES-GCM decryption (the password-derived step). The
 * fingerprint is computed via `computeSeedFingerprint`, not pulled
 * from a keystore.
 */

import {
  type UnlockedWallet,
  computeSeedFingerprint,
  deriveAddresses,
  deriveAllKeys,
  mnemonicToSeed,
} from '@smirk/core';

/**
 * Build an `UnlockedWallet` from a raw BIP-39 mnemonic. Uses the v3
 * derivation depth (3) — same as production unlock.
 */
export function unlockedWalletFromMnemonic(mnemonic: string): UnlockedWallet {
  const trimmed = mnemonic.trim();
  if (!trimmed) {
    throw new Error('unlockedWalletFromMnemonic: empty mnemonic');
  }
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount !== 12 && wordCount !== 24) {
    throw new Error(
      `unlockedWalletFromMnemonic: expected 12 or 24 BIP-39 words, got ${wordCount}`,
    );
  }

  const seed = mnemonicToSeed(trimmed);
  const keys = deriveAllKeys(trimmed, '', 3);
  const addresses = deriveAddresses(keys);
  const fingerprint = computeSeedFingerprint(trimmed);

  return {
    mnemonic: trimmed,
    seed,
    keys,
    addresses,
    fingerprint,
  };
}
