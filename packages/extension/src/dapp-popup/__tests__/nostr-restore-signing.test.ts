/**
 * Regression test for the chat-signing bug: after a "stay unlocked for N
 * hours" session-cache restore, the wallet carries NO mnemonic (2026-06-13
 * hardening), so `signNostrEventWithUnlocked` used to throw. It now signs from
 * the cached account-0 nostr key in `wallet.keys.nostr`. This pins that
 * behaviour against a restored (mnemonic-less) wallet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveNostrIdentity,
  deriveNostrKeyFromSeed,
  mnemonicToSeed,
  verifyNostrEventId,
  type UnlockedWallet,
} from '@smirk/core';
import { signNostrEventWithUnlocked } from '../signers';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** A wallet shaped like `restoreUnlockedFromCache` output: cached derived keys,
 *  NO mnemonic and NO seed. */
function restoredWallet(): UnlockedWallet {
  const nostr = deriveNostrKeyFromSeed(mnemonicToSeed(TEST_MNEMONIC), 0);
  return {
    keys: { nostr } as UnlockedWallet['keys'],
    addresses: {} as UnlockedWallet['addresses'],
    fingerprint: 'fp-ext',
    // mnemonic + seed intentionally absent (session-cache restore).
  };
}

test('signNostrEventWithUnlocked signs a kind-1 event on a restored (mnemonic-less) wallet', () => {
  const wallet = restoredWallet();
  assert.equal(wallet.mnemonic, undefined, 'restored wallet has no mnemonic');

  const signed = signNostrEventWithUnlocked(wallet, {
    kind: 1,
    content: 'gm from a restored session',
    tags: [],
  });

  assert.equal(signed.kind, 1);
  assert.ok(verifyNostrEventId(signed.sig, signed.id, signed.pubkey), 'schnorr sig verifies');
  // It is the wallet's real account-0 identity, same as a fresh unlock.
  assert.equal(signed.pubkey, deriveNostrIdentity(TEST_MNEMONIC, 0).pubkeyHex);
});

test('signNostrEventWithUnlocked throws only when BOTH the cached key and the mnemonic are absent', () => {
  const empty = {
    keys: {} as UnlockedWallet['keys'],
    addresses: {} as UnlockedWallet['addresses'],
    fingerprint: 'fp-empty',
  } as UnlockedWallet;
  assert.throws(
    () => signNostrEventWithUnlocked(empty, { kind: 1, content: 'x', tags: [] }),
    /re-unlock the wallet/,
  );
});
