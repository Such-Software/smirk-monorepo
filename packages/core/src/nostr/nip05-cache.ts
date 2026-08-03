/**
 * Cached, TOFU-pinning NIP-05 resolver (federation hardening). Wraps
 * {@link resolveNip05} with two protections against the "follow the key, not the
 * name" threat where a compromised or hostile domain substitutes a different key:
 *
 *   - TOFU key-pinning: the FIRST time a name resolves, its pubkey is pinned
 *     (persisted). On a later resolve, if the name maps to a DIFFERENT key, the
 *     result is flagged `keyChanged` and the new key is NOT auto-accepted; the
 *     caller must warn the user and `confirmPin` before trusting it. This turns a
 *     silent key swap into a visible, user-gated event.
 *   - Short-TTL memory cache: avoids re-fetching the well-known on every send/DM
 *     (each fetch is a fresh substitution window + latency).
 *
 * Pure over injected dependencies: a persistent pin store, the fetch impl, the
 * clock. The extension wires a chrome.storage-backed pin store.
 */

import { resolveNip05, splitNip05, type Nip05Resolution, type Nip05Error } from './nip05';

/** Persistent first-seen pubkey per canonical `name@domain`. */
export interface Nip05PinStore {
  get(key: string): Promise<string | null>;
  set(key: string, pubkeyHex: string): Promise<void>;
}

export type Nip05CachedResult =
  | { ok: true; resolution: Nip05Resolution; keyChanged: false; firstSeen: boolean }
  /** The name resolved to a DIFFERENT key than previously pinned; do NOT trust
   *  without user confirmation (call {@link Nip05Resolver.confirmPin}). */
  | { ok: true; resolution: Nip05Resolution; keyChanged: true; pinnedPubkeyHex: string }
  | { ok: false; error: Nip05Error };

export interface Nip05Resolver {
  /** Resolve, honoring the cache + pin. `force` bypasses the memory cache. */
  resolve(
    identifier: string,
    opts?: { homeDomain?: string; force?: boolean },
  ): Promise<Nip05CachedResult>;
  /** Accept a changed key (user confirmed): re-pins + drops the cache entry. */
  confirmPin(identifier: string, pubkeyHex: string, opts?: { homeDomain?: string }): Promise<void>;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_HOME = 'smirk.cash';

function canonicalKey(identifier: string, homeDomain: string): string {
  const { name, domain } = splitNip05(identifier, homeDomain);
  return `${name}@${domain}`;
}

export function createNip05Resolver(deps: {
  pins: Nip05PinStore;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}): Nip05Resolver {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; resolution: Nip05Resolution }>();

  return {
    async resolve(identifier, opts = {}) {
      const homeDomain = opts.homeDomain ?? DEFAULT_HOME;
      const key = canonicalKey(identifier, homeDomain);

      if (!opts.force) {
        const hit = cache.get(key);
        if (hit && now() - hit.at < ttlMs) {
          return { ok: true, resolution: hit.resolution, keyChanged: false, firstSeen: false };
        }
      }

      const res = await resolveNip05(identifier, {
        homeDomain,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      if (!res.ok) return { ok: false, error: res.error };

      const pinned = await deps.pins.get(key);
      if (pinned && pinned !== res.resolution.pubkeyHex) {
        // Key changed since first-seen: surface it; do NOT cache or re-pin.
        return { ok: true, resolution: res.resolution, keyChanged: true, pinnedPubkeyHex: pinned };
      }
      if (!pinned) await deps.pins.set(key, res.resolution.pubkeyHex); // TOFU
      cache.set(key, { at: now(), resolution: res.resolution });
      return { ok: true, resolution: res.resolution, keyChanged: false, firstSeen: !pinned };
    },

    async confirmPin(identifier, pubkeyHex, opts = {}) {
      const key = canonicalKey(identifier, opts.homeDomain ?? DEFAULT_HOME);
      await deps.pins.set(key, pubkeyHex);
      cache.delete(key);
    },
  };
}
