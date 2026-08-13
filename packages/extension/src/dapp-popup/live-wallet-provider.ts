/**
 * Live `WalletProvider` for wallet-foreground contexts.
 *
 * The Chrome MV3 extension uses `chromePublicCacheProvider`, which
 * reads from a public-material cache the popup writes to
 * `chrome.storage.local` on unlock. The cache exists because the SW
 * (where the WalletHandler runs) doesn't share memory with the popup:
 * it can't read the unlocked wallet directly.
 *
 * On Tauri desktop (and future Capacitor mobile) there IS no SW.
 * The WalletHandler runs INSIDE the wallet UI process, so it can
 * read the unlocked wallet directly. Going through the cache here
 * would add a stale-read failure mode for no benefit, and one such
 * failure mode actually bit us during v0.3.0 smoke testing: with
 * `autoLockMinutes = 0` (the default), the popup wrote the cache with
 * `sessionExpiresAtMs = now`, which the cache provider treated as
 * already expired, so every desktop dapp call came back as `LOCKED`
 * even when the wallet was plainly unlocked. That write is fixed now
 * (auto-lock 0 omits the stamp entirely, see `dappPublicCacheFor`), so
 * it is no longer the reason to avoid the cache here; the reason below
 * is. Kept as the record of why this provider exists.
 *
 * This provider reads the live wallet via a `getWallet` callback:
 * BrowseTab passes a ref-reader so the provider always sees the
 * latest unlock state, even if it changed between request arrival
 * and approval.
 */

import { bytesToHex } from '@noble/hashes/utils';
import { api, deriveNostrIdentity, type UnlockedWallet } from '@smirk/core';
import {
  emptyPublicKeys,
  type SmirkAddresses,
  type SmirkAsset,
  type SmirkPublicKeys,
  type WalletProvider,
} from '@such-software/smirk-dapp-api';

function emptyAddresses(): SmirkAddresses {
  return { btc: null, ltc: null, xmr: null, wow: null, grin: null };
}

/**
 * Build a `WalletProvider` that reads the unlocked wallet via the
 * given callback. `getWallet()` should return `null` when the wallet
 * is locked or absent; the provider reports `isUnlocked: false` and
 * empty key/address maps in that case, mirroring the contract of
 * `chromePublicCacheProvider`.
 */
export function createLiveWalletProvider(
  getWallet: () => UnlockedWallet | null,
): WalletProvider {
  return {
    async isUnlocked(): Promise<boolean> {
      return getWallet() !== null;
    },

    async getPublicKeys(assets: SmirkAsset[]): Promise<SmirkPublicKeys> {
      const wallet = getWallet();
      if (!wallet) return emptyPublicKeys();
      const all: Record<SmirkAsset, string> = {
        btc: bytesToHex(wallet.keys.btc.publicKey),
        ltc: bytesToHex(wallet.keys.ltc.publicKey),
        // CryptoNote dapps want the public *spend* key: same field
        // bootstrapAuth sends to the backend's key-list. See
        // `dappPublicCacheFor` in the popup for the same convention.
        xmr: bytesToHex(wallet.keys.xmr.publicSpendKey),
        wow: bytesToHex(wallet.keys.wow.publicSpendKey),
        grin: bytesToHex(wallet.keys.grin.publicKey),
      };
      const out = emptyPublicKeys();
      for (const a of assets) out[a] = all[a];
      return out;
    },

    async getAddresses(assets: SmirkAsset[]): Promise<SmirkAddresses> {
      const wallet = getWallet();
      if (!wallet) return emptyAddresses();
      const out = emptyAddresses();
      for (const a of assets) out[a] = wallet.addresses[a];
      return out;
    },

    async getNostrPublicKey(): Promise<string | null> {
      const wallet = getWallet();
      if (!wallet) return null;
      // Prefer the cached account-0 nostr pubkey (survives a session-cache
      // restore, which drops the mnemonic). Fall back to deriving from the
      // mnemonic on a fresh unlock; null only if neither is available.
      if (wallet.keys.nostr) return bytesToHex(wallet.keys.nostr.publicKey);
      if (wallet.mnemonic) return deriveNostrIdentity(wallet.mnemonic, 0).pubkeyHex;
      return null;
    },

    async getBackendUrl(): Promise<string> {
      return api.getBaseUrl();
    },
  };
}
