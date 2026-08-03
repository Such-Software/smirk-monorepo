/**
 * Chrome-side `WalletProvider`. Backed by a *public-material* cache
 * the popup writes into `chrome.storage.local` whenever the wallet
 * unlocks. The SW reads from that cache — it does NOT hold the seed
 * or any private key itself.
 *
 * **Why a public-cache instead of "share the unlocked wallet with the
 * SW".** The SW is an evictable, cross-process context. Keeping
 * seed bytes in `chrome.storage.session` for the SW to find on
 * respawn is exactly the anti-pattern the v0.3 security posture
 * rejects: it leaves seed material in storage that outlives the
 * foreground context the user authorized, readable by every SW
 * respawn thereafter. The popup is the trusted,
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
} from '@such-software/smirk-dapp-api';
import { emptyPublicKeys } from '@such-software/smirk-dapp-api';

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
  /** Seed-derived account-0 Nostr public key (x-only hex). This is the FALLBACK
   *  identity: an origin granted a specific identity carries it on
   *  `OriginPermission.nostrPubkey`, which the wallet-handler prefers over this
   *  field. Public material — lets the dapp bridge answer getNostrPublicKey()
   *  without the seed. Optional for backward compat with pre-nostr cache entries. */
  nostrPublicKey?: string;
  /** Backend API base URL the wallet is pointed at, so a page can discover the
   *  user's chosen backend via getBackend(). Optional for backward compat. */
  backendUrl?: string;
  /** Unix ms when the popup last wrote this. Used as a coarse
   *  "wallet is currently unlocked" signal — see file header. */
  unlockedAt: number;
  /**
   * Unix ms when the session-cache auto-lock TTL expires, capped at
   * `AUTO_LOCK_MAX_MINUTES` (24h) from the write; `Date.now()` when
   * auto-lock is immediate, which makes the cache stale the moment it
   * is written. There is no "Never" sentinel. Used by
   * the SW provider to detect "wallet was unlocked but the session
   * has since timed out and the popup hasn't been opened to clear
   * the cache". Per Finding 13 in the v0.3.0 pre-ship audit. Optional
   * for backward compat — pre-2026-06-04 cache entries lack this
   * field and fall back to the legacy "presence == unlocked" check.
   */
  sessionExpiresAtMs?: number;
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

    async getNostrPublicKey(): Promise<string | null> {
      const cache = await readCache();
      return cache?.nostrPublicKey ?? null;
    },

    async getBackendUrl(): Promise<string> {
      const cache = await readCache();
      return cache?.backendUrl ?? '';
    },
  };
}

/**
 * Read the public cache, returning `null` when the wallet should be
 * treated as locked. Per Finding 13 (v0.3.0 pre-ship audit): the
 * raw presence of the cache is no longer sufficient — a session
 * auto-lock can expire without the popup ever opening to call
 * `clearDappPublicCache()`, leaving the SW provider falsely
 * reporting "unlocked" until the next popup interaction. We now
 * additionally enforce `sessionExpiresAtMs > now`, defensively
 * clearing the stale entry from storage so the next read is fast.
 * Backward compat: entries without `sessionExpiresAtMs` (pre-fix
 * cache writes) fall through to the legacy "presence == unlocked"
 * behavior. New writes always populate the field.
 */
async function readCache(): Promise<DappPublicCache | null> {
  const res = await chrome.storage.local.get(PUBLIC_CACHE_KEY);
  const v = res[PUBLIC_CACHE_KEY] as DappPublicCache | undefined;
  if (!v || typeof v !== 'object' || typeof v.fingerprint !== 'string') {
    return null;
  }
  if (
    typeof v.sessionExpiresAtMs === 'number' &&
    Date.now() >= v.sessionExpiresAtMs
  ) {
    // Stale — popup never opened to clear it after session expiry.
    // GC it so subsequent reads are fast (and so the website's
    // `isUnlocked` response is accurate from this point on).
    try {
      await chrome.storage.local.remove(PUBLIC_CACHE_KEY);
    } catch {
      // Swallow — worst case the next read also pays the TTL check.
    }
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
