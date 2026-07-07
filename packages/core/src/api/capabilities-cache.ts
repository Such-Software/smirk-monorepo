/**
 * Session-scoped capabilities cache. `GET /capabilities` was previously re-fetched
 * ad-hoc at every use site (onboarding, auth bootstrap, the messages screen, the
 * backend picker) with no sharing. This memoizes it per backend URL so:
 *   - components read one shared result (via a `useCapabilities` hook), and
 *   - poll loops can `peekCapabilities()` SYNCHRONOUSLY before firing a request
 *     the backend doesn't support (killing 404 noise on minimal/opt-in backends).
 *
 * The cache key is the api base URL, so switching backends is a natural cache
 * miss → refetch. A failed fetch caches `null` (a legacy pre-/capabilities backend
 * or an unreachable one) — the `capAllows*` gates read `null` as permissive, so
 * old behavior is preserved and nothing is hidden mid-load.
 */

import type { BackendCapabilities } from './capabilities';

/** Minimal structural view of the api client — avoids importing the concrete
 *  class (and its transitive deps) into this leaf module. */
export interface CapabilitiesApi {
  getBaseUrl(): string;
  getCapabilities(): Promise<{ data?: BackendCapabilities | null }>;
}

interface CacheEntry {
  key: string;
  caps: BackendCapabilities | null;
  promise: Promise<BackendCapabilities | null>;
}

let cache: CacheEntry | null = null;

/**
 * Load this backend's capabilities, memoized per base URL. Concurrent callers
 * share one in-flight request; a settled result is reused for the session. Pass
 * `{ force: true }` to bypass the cache (e.g. after an operator changes config).
 */
export function loadCapabilities(
  api: CapabilitiesApi,
  opts?: { force?: boolean },
): Promise<BackendCapabilities | null> {
  const key = api.getBaseUrl();
  if (!opts?.force && cache && cache.key === key) return cache.promise;
  const entry: CacheEntry = { key, caps: null, promise: Promise.resolve(null) };
  entry.promise = api
    .getCapabilities()
    .then((r) => {
      const caps = r.data ?? null;
      if (cache === entry) entry.caps = caps;
      return caps;
    })
    .catch(() => null);
  cache = entry;
  return entry.promise;
}

/**
 * The last-loaded capabilities, synchronously. `null` until the first
 * {@link loadCapabilities} resolves, or if the backend advertises none. Poll
 * loops use this to skip unsupported calls without awaiting.
 */
export function peekCapabilities(): BackendCapabilities | null {
  return cache?.caps ?? null;
}

/** Drop the cache (call on backend switch / operator config change so the next
 *  read refetches and `peek` doesn't return the previous backend's caps). */
export function invalidateCapabilities(): void {
  cache = null;
}
