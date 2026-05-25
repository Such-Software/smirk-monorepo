/**
 * Chrome-side `WalletProvider`. Backed by a *public-material* cache
 * the popup writes into `chrome.storage.local` whenever the wallet
 * unlocks. The SW reads from that cache — it does NOT hold the seed
 * or any private key itself.
 *
 * **Why a public-cache instead of "share the unlocked wallet with the
 * SW".** The SW is an evictable, cross-process context. Keeping
 * seed bytes in `chrome.storage.session` for the SW to find on
 * respawn is exactly the audit-flagged anti-pattern the v0.3
 * security posture rejects (see
 * `smirk-monorepo/docs/SECURITY_AUDIT.md`). The popup is the trusted,
 * user-foreground context — it holds the unlocked seed; the SW only
 * needs to answer a few cache-friendly questions about pubkeys and
 * addresses (which are not secret), and routes everything sensitive
 * back to a popup window via the approval handler.
 *
 * Cache contract:
 *   key:   `smirk:dapp:public-cache:v1`
 *   value: { fingerprint, addresses, publicKeys, unlockedAt }
 *
 * `unlockedAt` doubles as the `isUnlocked()` signal — the popup
 * touches it on every unlock and clears the key on `lock()` /
 * `destroy()`. If the popup process never wrote a cache (fresh
 * install, or wallet locked at SW boot), we report `isUnlocked: false`
 * and every sensitive method comes back as `LOCKED` to the dapp.
 *
 * **Staleness.** We do NOT auto-expire the cache from the SW — the
 * popup is responsible for clearing it on lock. If the popup is
 * killed mid-flow without clearing (e.g., user force-quits Chrome),
 * the cache will linger; the worst that happens is `isUnlocked`
 * returns true while the user thinks they're locked. The actual
 * signing flow will still re-prompt for password inside the approval
 * popup if the unlocked state isn't there, so a stale cache cannot
 * unlock anything.
 */

import type {
  SmirkAddresses,
  SmirkAsset,
  SmirkPublicKeys,
  WalletProvider,
} from '@smirk/dapp-api';
import { emptyPublicKeys } from '@smirk/dapp-api';

export const PUBLIC_CACHE_KEY = 'smirk:dapp:public-cache:v1';

/** Shape the popup writes to `chrome.storage.local`. Public material
 *  only — safe to read from any context. */
export interface DappPublicCache {
  /** SHA-256(SHA-256(seed)) — matches the keystore fingerprint. Lets
   *  the popup detect a stale cache from a previously-different
   *  wallet and refuse to use it. */
  fingerprint: string;
  addresses: SmirkAddresses;
  publicKeys: SmirkPublicKeys;
  /** Unix ms when the popup last wrote this. Used as a coarse
   *  "wallet is currently unlocked" signal — see file header. */
  unlockedAt: number;
}

export function chromePublicCacheProvider(): WalletProvider {
  return {
    async isUnlocked(): Promise<boolean> {
      const cache = await readCache();
      return cache !== null;
    },

    async getPublicKeys(assets: SmirkAsset[]): Promise<SmirkPublicKeys> {
      const cache = await readCache();
      if (!cache) return emptyPublicKeys();
      return projectPublicKeys(cache.publicKeys, assets);
    },

    async getAddresses(assets: SmirkAsset[]): Promise<SmirkAddresses> {
      const cache = await readCache();
      if (!cache) return emptyAddresses();
      return projectAddresses(cache.addresses, assets);
    },
  };
}

async function readCache(): Promise<DappPublicCache | null> {
  const res = await chrome.storage.local.get(PUBLIC_CACHE_KEY);
  const v = res[PUBLIC_CACHE_KEY] as DappPublicCache | undefined;
  if (!v || typeof v !== 'object' || typeof v.fingerprint !== 'string') {
    return null;
  }
  return v;
}

function projectPublicKeys(
  full: SmirkPublicKeys,
  assets: SmirkAsset[],
): SmirkPublicKeys {
  const out = emptyPublicKeys();
  for (const a of assets) out[a] = full[a];
  return out;
}

function projectAddresses(
  full: SmirkAddresses,
  assets: SmirkAsset[],
): SmirkAddresses {
  const out = emptyAddresses();
  for (const a of assets) out[a] = full[a];
  return out;
}

function emptyAddresses(): SmirkAddresses {
  return { btc: null, ltc: null, xmr: null, wow: null, grin: null };
}

// ============================================================================
// Popup-side helpers — keep the cache write/clear in one place so the
// popup doesn't need to know the storage key shape.
// ============================================================================

/** Popup helper. Call on every transition to `unlocked` (fresh
 *  create, password unlock, session-cache restore). Idempotent. */
export async function writeDappPublicCache(
  cache: DappPublicCache,
): Promise<void> {
  await chrome.storage.local.set({ [PUBLIC_CACHE_KEY]: cache });
}

/** Popup helper. Call on every transition out of `unlocked`
 *  (lock, destroy). Idempotent. */
export async function clearDappPublicCache(): Promise<void> {
  await chrome.storage.local.remove(PUBLIC_CACHE_KEY);
}
