import type { BootstrapAuthResult } from '@smirk/core';
import { sessionStorage } from './singletons';

// ============================================================================
// Bootstrap (JWT + userId + LWS heights) cache — chrome.storage.session
// scoped, ~5 min TTL. Skipping the auth round-trip on every popup open
// shaves 1-2s off the warm-open feel; the cache dies on browser restart
// AND on wallet fingerprint change (defensive: a re-imported wallet
// must NOT inherit the previous wallet's JWT).
//
// Threat model: the access token is short-lived (server-controlled, ~1h),
// the storage tier is non-persistent (browser-session lifetime), and a
// stale-cache hit either succeeds (fast path) or surfaces an auth error
// which we recover from by clearing the cache and re-bootstrapping. No
// regression vs. the in-memory-only baseline that auditors signed off on
// for v0.2.x — the access token never touches chrome.storage.local
// (which IS persistent and IS the legacy anti-pattern).
// ============================================================================

const BOOTSTRAP_CACHE_KEY = 'smirk_bootstrap_cache_v1';
const BOOTSTRAP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface BootstrapCacheEntry {
  fingerprint: string;
  accessToken: string;
  bootstrap: BootstrapAuthResult;
  cachedAt: number;
}

export async function readBootstrapCache(
  walletFingerprint: string,
): Promise<{ accessToken: string; bootstrap: BootstrapAuthResult } | null> {
  try {
    const raw = await sessionStorage.get(BOOTSTRAP_CACHE_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as BootstrapCacheEntry;
    if (entry.fingerprint !== walletFingerprint) return null;
    if (Date.now() - entry.cachedAt > BOOTSTRAP_CACHE_TTL_MS) return null;
    if (!entry.accessToken || !entry.bootstrap?.userId) return null;
    return { accessToken: entry.accessToken, bootstrap: entry.bootstrap };
  } catch {
    return null;
  }
}

export async function writeBootstrapCache(
  walletFingerprint: string,
  accessToken: string,
  bootstrap: BootstrapAuthResult,
): Promise<void> {
  const entry: BootstrapCacheEntry = {
    fingerprint: walletFingerprint,
    accessToken,
    bootstrap,
    cachedAt: Date.now(),
  };
  try {
    await sessionStorage.set(BOOTSTRAP_CACHE_KEY, entry);
  } catch (e) {
    console.warn('[smirk] bootstrap cache write failed', e);
  }
}

export async function clearBootstrapCache(): Promise<void> {
  try {
    await sessionStorage.remove(BOOTSTRAP_CACHE_KEY);
  } catch {
    /* best-effort */
  }
}
