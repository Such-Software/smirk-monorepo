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
