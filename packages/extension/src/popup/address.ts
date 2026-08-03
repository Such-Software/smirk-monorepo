/**
 * Address validation + receive-address resolution for the popup. Pure (no React,
 * no module state); extracted from index.tsx. The actual codecs live in
 * @smirk/core (regression-tested in packages/core address.test.ts); this is the
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
import {
  receiveSubaddrIndexFor,
  subaddressAt,
  subaddressReceiveEnabled,
} from './receive-subaddress-index';

/**
 * Per-asset address validation. Returns `null` when `addr` decodes correctly for
 * the asset, or a short user-facing reason string. For CryptoNote chains it points
 * at the first out-of-alphabet character: copy-paste from chat often injects
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
 * The asset's PRIMARY receive address: the wallet's one canonical address per
 * chain, unchanged since v0.2. Grin is special-cased to the wasm canonical
 * slatepack derivation (NOT the legacy `wallet.addresses.grin`) so the shared
 * address matches the one used for encryption + decryption end-to-end. Requires
 * wasm to be initialized.
 *
 * Kept as its own sync export so the Receive screen can always surface the
 * primary address (an "advanced" disclosure) even while showing a subaddress,
 * and so every non-receive consumer keeps the old, flag-independent behavior.
 */
export function primaryAddressForAsset(wallet: UnlockedWallet, assetId: string): string {
  if (assetId === 'grin' && wallet.mnemonic) {
    return canonicalGrinSlatepackAddress(wallet.mnemonic);
  }
  const addr = (wallet.addresses as unknown as Record<string, string | undefined>)[assetId];
  if (!addr) throw new Error(`No receive address for asset "${assetId}"`);
  return addr;
}

/**
 * Resolve the receive address to DISPLAY for an asset.
 *
 * PURE and IDEMPOTENT by contract. It reads the issuance counter, it never
 * advances it: `ReceiveScreen`'s address effect re-fires on every render (the
 * shell passes an inline closure, so the `resolveAddress` prop is a new
 * identity each time), and a resolver with a side effect would burn a fresh
 * subaddress per frame. Only the explicit "New address" action advances
 * (see `issueNewReceiveAddress`).
 *
 * Behavior:
 * - BTC / LTC / Grin: unchanged, identical to {@link primaryAddressForAsset}.
 * - XMR / WOW with `ENABLE_SUBADDRESS_RECEIVE` OFF (the default): the primary
 *   address, exactly as today. No storage read, no derivation.
 * - XMR / WOW with the flag ON: the account-0 subaddress at the currently
 *   issued minor index, or the primary address while `issued == 0` (nothing
 *   has been handed out yet). Derivation is deterministic from the wallet keys
 *   plus that index, so repeated calls at a fixed index return the same string.
 *
 * FAILS CLOSED. A subaddress is only ever displayed when the stored counter
 * satisfies `1 <= issued <= provisionedCeiling`. Anything else shows the
 * primary address instead: a counter that somehow ran past the ceiling, a
 * ceiling the server has since lowered, or a book belonging to a backend that
 * provisioned nothing. Showing the primary again is a privacy regression the user can see;
 * showing an unprovisioned subaddress silently loses sight of money sent to it,
 * because the LWS never reports an output it is not scanning.
 *
 * `backendUrl` scopes the counter. Omitting it reads the "unknown backend"
 * bucket, which is empty on a fresh install and so resolves to the primary
 * address; it never reads another backend's ceiling.
 */
export async function resolveAddressForAsset(
  wallet: UnlockedWallet,
  assetId: string,
  backendUrl?: string,
): Promise<string> {
  if ((assetId === 'xmr' || assetId === 'wow') && subaddressReceiveEnabled()) {
    const state = await receiveSubaddrIndexFor(wallet.fingerprint, assetId, backendUrl).read();
    // `issued == 0` is "primary is current"; Monero reserves minor 0 of
    // account 0 for the primary address, so there is no subaddress to derive.
    if (state.issued >= 1 && state.issued <= state.provisionedCeiling) {
      return subaddressAt(wallet, assetId, state.issued);
    }
  }
  return primaryAddressForAsset(wallet, assetId);
}

/**
 * Validate a SEND recipient. Same as {@link validateAddress}, but for Grin it
 * ALSO accepts a Nostr `npub` (or raw x-only hex): a send to an npub routes over
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
    // here; resolution against the domain's /.well-known/nostr.json happens at
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
