/**
 * The wallet-handler's window into wallet state. Pure interface so
 * unit tests can plug in a fake without spinning up the keystore,
 * and so Capacitor/Tauri reuse the chrome impl's logic by just
 * supplying a different provider.
 *
 * **Scope:** ONLY publicly-derivable, non-secret operations live
 * here. Signing, payments, and tip claims all flow through the
 * approval handler (see `./approval.ts`) — that's the context that
 * holds the unlocked seed. Keeping the provider surface to public
 * material means the platform adapter can wire it up from a
 * shareable cache (e.g., a `chrome.storage.local` snapshot the
 * unlocked-popup writes on unlock) without ever exposing a key.
 */

import {
  SmirkAddresses,
  SmirkAsset,
  SmirkPublicKeys,
} from './protocol';

export interface WalletProvider {
  /** True iff a wallet keystore exists AND is currently unlocked.
   *  Wallet-handler refuses every method other than `isConnected`
   *  with 'LOCKED' when this is false.
   *
   *  Implementations may approximate "unlocked" by the presence of a
   *  recent public-cache snapshot, since the actual unlocked-mnemonic
   *  state is in a different context. See the chrome adapter for the
   *  reference implementation. */
  isUnlocked(): Promise<boolean>;
  /** Public keys for the given asset set. Implementations should
   *  return `null` per-asset when the wallet has no key for that
   *  asset (e.g., an old wallet imported without Grin). */
  getPublicKeys(assets: SmirkAsset[]): Promise<SmirkPublicKeys>;
  /** Receive addresses for the given asset set. Same null-for-missing
   *  semantics as `getPublicKeys`. */
  getAddresses(assets: SmirkAsset[]): Promise<SmirkAddresses>;
}
