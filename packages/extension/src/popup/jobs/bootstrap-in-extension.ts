/**
 * Drop-in replacement for the popup's two `bootstrapAuth` call
 * sites. Identical observable behaviour from the popup's
 * perspective (sets the api access token, returns a
 * `BootstrapAuthResult`), but the heavy lifting runs in the SW so
 * the popup is free to close + reopen at will.
 *
 * Migration boundary: `@smirk/core.bootstrapAuth` stays for desktop
 * / future Capacitor hosts that don't have the popup-unmount
 * problem; this wrapper exists specifically for the extension.
 *
 * Side effects:
 *   - `api.setAccessToken(token)` on success.
 *   - No cache writes here — the caller decides what cache layer to
 *     populate (the popup already calls `writeBootstrapCache` and
 *     we don't want to step on that flow).
 *
 * Failures: the SW handler hard-throws when /auth/extension fails
 * (rate limit, invalid signature, wrong fingerprint match). The
 * popup surfaces the error to the user just like it would for an
 * inline bootstrap failure.
 */

import type { SmirkApi } from '@smirk/core';
import { bytesToHex, signBitcoinMessage } from '@smirk/core';
import type { UnlockedWallet } from '@smirk/core';

import { runBootstrapInBackground } from './bootstrap-auth';
import type { BootstrapJobResult } from './bootstrap-auth';

function buildKeysList(
  wallet: UnlockedWallet,
): ReadonlyArray<{ asset: string; publicKey: string }> {
  // Mirrors `@smirk/core.buildKeysList` (which isn't exported). Same
  // shape, same XMR/WOW spend-key convention — see the comment in
  // wallet-flow.ts on why this exact ordering matters for restore.
  return [
    { asset: 'btc', publicKey: bytesToHex(wallet.keys.btc.publicKey) },
    { asset: 'ltc', publicKey: bytesToHex(wallet.keys.ltc.publicKey) },
    { asset: 'xmr', publicKey: bytesToHex(wallet.keys.xmr.publicSpendKey) },
    { asset: 'wow', publicKey: bytesToHex(wallet.keys.wow.publicSpendKey) },
    { asset: 'grin', publicKey: bytesToHex(wallet.keys.grin.publicKey) },
  ];
}

/**
 * Runs the bootstrap via the background-jobs system. Always
 * compute the signature in-popup (private-key-bearing call); the SW
 * does the rest.
 */
export async function bootstrapAuthInExtension(
  api: SmirkApi,
  wallet: UnlockedWallet,
): Promise<BootstrapJobResult['bootstrap']> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `smirk-auth-${timestamp}`;
  const signature = signBitcoinMessage(message, wallet.keys.btc.privateKey);
  const keys = buildKeysList(wallet);

  const result = await runBootstrapInBackground({
    fingerprint: wallet.fingerprint,
    keys,
    signedTimestamp: timestamp,
    signature,
  });

  api.setAccessToken(result.accessToken);
  return result.bootstrap;
}
