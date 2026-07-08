/**
 * Address validation + receive-address resolution for the popup. Pure (no React,
 * no module state); extracted from index.tsx. The actual codecs live in
 * @smirk/core (regression-tested in packages/core address.test.ts) — this is the
 * per-asset dispatch + user-facing error shaping.
 */

import { mustGetAsset } from '@smirk/assets';
import {
  isValidBtcAddress,
  isValidLtcAddress,
  isValidXmrAddress,
  isValidWowAddress,
  isValidGrinSlatepackAddress,
  recipientToHex,
  type UnlockedWallet,
} from '@smirk/core';

import { canonicalGrinSlatepackAddress } from './grin-flows';

/**
 * Per-asset address validation. Returns `null` when `addr` decodes correctly for
 * the asset, or a short user-facing reason string. For CryptoNote chains it points
 * at the first out-of-alphabet character — copy-paste from chat often injects
 * `0`/`O`/`I`/`l` or HTML gunk that a generic "invalid" message doesn't help with.
 */
export function validateAddress(assetId: string, addr: string): string | null {
  const trimmed = addr.trim();
  if (!trimmed) return 'Address is empty';

  const ok =
    assetId === 'btc'
      ? isValidBtcAddress(trimmed)
      : assetId === 'ltc'
        ? isValidLtcAddress(trimmed)
        : assetId === 'xmr'
          ? isValidXmrAddress(trimmed)
          : assetId === 'wow'
            ? isValidWowAddress(trimmed)
            : assetId === 'grin'
              ? isValidGrinSlatepackAddress(trimmed)
              : false;

  if (ok) return null;

  const ticker = mustGetAsset(assetId).ticker;

  if (assetId === 'xmr' || assetId === 'wow') {
    const cnAlphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (let i = 0; i < trimmed.length; i++) {
      if (!cnAlphabet.includes(trimmed[i]!)) {
        return `Not a valid ${ticker} address — char '${trimmed[i]}' at position ${i + 1} isn't in base58 (likely copy-paste mangled)`;
      }
    }
  }

  return `Not a valid ${ticker} address`;
}

/**
 * Resolve the receive address for an asset from the unlocked wallet. Grin is
 * special-cased to the wasm canonical slatepack derivation (NOT the legacy
 * `wallet.addresses.grin`) so the shared address matches the one used for
 * encryption + decryption end-to-end. Requires wasm to be initialized.
 */
export function resolveAddressForAsset(wallet: UnlockedWallet, assetId: string): string {
  if (assetId === 'grin' && wallet.mnemonic) {
    return canonicalGrinSlatepackAddress(wallet.mnemonic);
  }
  const addr = (wallet.addresses as unknown as Record<string, string | undefined>)[assetId];
  if (!addr) throw new Error(`No receive address for asset "${assetId}"`);
  return addr;
}

/**
 * Validate a SEND recipient. Same as {@link validateAddress}, but for Grin it
 * ALSO accepts a Nostr `npub` (or raw x-only hex) — a send to an npub routes over
 * the gift-wrap channel instead of a slatepack address, so the sender doesn't need
 * to know the recipient's Grin address (the Goblin-interoperable path). Returns
 * null when valid, else a short reason.
 */
export function validateSendRecipient(assetId: string, addr: string): string | null {
  const t = addr.trim();
  if (assetId === 'grin') {
    if (t.startsWith('npub1') || /^[0-9a-fA-F]{64}$/.test(t)) {
      try {
        recipientToHex(t);
        return null;
      } catch {
        return 'Not a valid npub';
      }
    }
    // A NIP-05 name (federation): alice@goblin.st. Only the FORMAT is checked
    // here — resolution against the domain's /.well-known/nostr.json happens at
    // send time (a network call, not run per keystroke).
    if (isNip05Name(t)) return null;
  }
  return validateAddress(assetId, addr);
}

/** True if `s` looks like a NIP-05 identifier `name@domain.tld` (format only). */
export function isNip05Name(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
}

/** If `recipient` is an npub (or raw x-only hex), return its x-only pubkey hex;
 *  otherwise null (it's a plain slatepack/chain address). Used to decide whether a
 *  Grin send goes over the Nostr gift-wrap channel. */
export function recipientNpubToHex(recipient: string): string | null {
  const t = recipient.trim();
  if (!t.startsWith('npub1') && !/^[0-9a-fA-F]{64}$/.test(t)) return null;
  try {
    return recipientToHex(t);
  } catch {
    return null;
  }
}
