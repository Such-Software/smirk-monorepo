/**
 * Asset-agnostic signMessage executor used in any wallet-foreground
 * context that holds an `UnlockedWallet`. Runs in the approval popup
 * window on the browser extension, and in the BrowseTab dapp bridge
 * on Tauri desktop / Capacitor mobile — same code, no fork.
 *
 * Compute one signature per requested asset. BTC/LTC use the
 * canonical Bitcoin-message format (`signBitcoinMessage`); XMR/WOW
 * sign the raw UTF-8 message bytes with their ed25519 private
 * spend-key scalar; Grin signs with its slatepack ed25519 scalar.
 * All ed25519 signatures go through `signEd25519WithScalar` because
 * our keys are stored as raw scalars, not RFC-8032 seeds — passing
 * them to `ed25519.sign` would re-clamp into a different scalar and
 * yield signatures that don't verify against the public keys we
 * actually publish.
 *
 * Per-asset failures are captured per-asset (empty signature string)
 * rather than aborting the whole result — smirk.cash and similar
 * dapps pick the signature for the asset the user chose, so one
 * failing asset shouldn't kill the others.
 */

import { bytesToHex } from '@noble/hashes/utils';
import {
  signBitcoinMessage,
  signEd25519WithScalar,
  type UnlockedWallet,
} from '@smirk/core';
import type { SmirkAsset, SmirkSignResult } from '@such-software/smirk-dapp-api';

export function signMessageWithUnlocked(
  wallet: UnlockedWallet,
  message: string,
  assets: SmirkAsset[],
): SmirkSignResult {
  const msgBytes = new TextEncoder().encode(message);
  const signatures: SmirkSignResult['signatures'] = [];
  for (const asset of assets) {
    try {
      switch (asset) {
        case 'btc':
          signatures.push({
            asset: 'btc',
            signature: signBitcoinMessage(message, wallet.keys.btc.privateKey),
            publicKey: bytesToHex(wallet.keys.btc.publicKey),
          });
          break;
        case 'ltc':
          signatures.push({
            asset: 'ltc',
            signature: signBitcoinMessage(message, wallet.keys.ltc.privateKey),
            publicKey: bytesToHex(wallet.keys.ltc.publicKey),
          });
          break;
        case 'xmr': {
          const pub = wallet.keys.xmr.publicSpendKey;
          signatures.push({
            asset: 'xmr',
            signature: bytesToHex(
              signEd25519WithScalar(msgBytes, wallet.keys.xmr.privateSpendKey, pub),
            ),
            publicKey: bytesToHex(pub),
          });
          break;
        }
        case 'wow': {
          const pub = wallet.keys.wow.publicSpendKey;
          signatures.push({
            asset: 'wow',
            signature: bytesToHex(
              signEd25519WithScalar(msgBytes, wallet.keys.wow.privateSpendKey, pub),
            ),
            publicKey: bytesToHex(pub),
          });
          break;
        }
        case 'grin': {
          const pub = wallet.keys.grin.publicKey;
          signatures.push({
            asset: 'grin',
            signature: bytesToHex(
              signEd25519WithScalar(msgBytes, wallet.keys.grin.privateKey, pub),
            ),
            publicKey: bytesToHex(pub),
          });
          break;
        }
      }
    } catch (e) {
      console.error(`[signMessage] ${asset} signing failed:`, e);
      // Emit nothing for this asset — see file header. The dapp
      // surfaces it as "No signature found for <asset>".
    }
  }
  return { message, signatures };
}
