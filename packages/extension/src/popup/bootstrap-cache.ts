import type { BootstrapAuthResult } from '@smirk/core';
import { sessionStorage } from './singletons';
import { readSessionExpiry } from './session-cache';

// ============================================================================
// Bootstrap (JWT + userId + LWS heights) cache: chrome.storage.session
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
// for v0.2.x: the access token never touches chrome.storage.local
// (which IS persistent and IS the legacy anti-pattern).
//
// Backend-scoped: an entry names the backend that minted its token, and a
// read for any other backend misses. Keyed by wallet alone, a token that
// reached the cache from one backend was handed to whichever backend the
// next warm open pointed at.
// ============================================================================

const BOOTSTRAP_CACHE_KEY = 'smirk_bootstrap_cache_v1';

/**
 * Fallback lifetime, used only when the caller cannot say when the wallet
 * locks. Prefer passing the session's own expiry: see below for why a fixed TTL
 * here was a bug rather than a conservative default.
 */
const BOOTSTRAP_CACHE_FALLBACK_TTL_MS = 5 * 60 * 1000;

interface BootstrapCacheEntry {
  fingerprint: string;
  /** The backend that minted `accessToken`. Absent on an entry written before
   *  entries were bound to their backend, which no read accepts. */
  backendUrl?: string;
  accessToken: string;
  bootstrap: BootstrapAuthResult;
  cachedAt: number;
  /**
   * When this entry stops being valid. Tracks the wallet's own auto-lock
   * expiry.
   *
   * This used to be a flat five minutes while the session cache lived for the
   * user's configured auto-lock, and the two disagreeing is what produced the
   * dead zone: the session cache is mnemonic-less by design, so once the token
   * expired at five minutes the wallet was still "unlocked" but could neither
   * present a token nor sign for a new one. Every call then failed with
   * "Missing authorization header" and the sign-in path failed with "needs the
   * unlocked mnemonic", both surfacing raw to the user. With auto-lock at
   * fifteen minutes that was a ten-minute window; longer settings made it
   * worse, so the users who most wanted to stay unlocked were hurt the most.
   *
   * Optional so an entry written by an older build is still readable; those
   * fall back to the flat TTL.
   */
  expiresAtMs?: number;
}

/** The cached sign-in for this wallet at `backendUrl`, or null. An entry for
 *  another wallet or another backend never matches. */
export async function readBootstrapCache(
  walletFingerprint: string,
  backendUrl: string,
): Promise<{ accessToken: string; bootstrap: BootstrapAuthResult } | null> {
  try {
    const raw = await sessionStorage.get(BOOTSTRAP_CACHE_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as BootstrapCacheEntry;
    if (entry.fingerprint !== walletFingerprint) return null;
    if (!entry.backendUrl || entry.backendUrl !== backendUrl) return null;
    const expiresAtMs =
      entry.expiresAtMs ?? entry.cachedAt + BOOTSTRAP_CACHE_FALLBACK_TTL_MS;
    if (Date.now() >= expiresAtMs) return null;
    if (!entry.accessToken || !entry.bootstrap?.userId) return null;
    return { accessToken: entry.accessToken, bootstrap: withoutNewWalletAdmission(entry.bootstrap) };
  } catch {
    return null;
  }
}

/**
 * Cache a sign-in. `backendUrl` is the backend that minted `accessToken`: the
 * only one a later read hands it back for.
 *
 * `sessionExpiresAtMs` is when the unlocked session itself expires. Pass it
 * whenever it is known, so the token outlives nothing and nothing outlives the
 * token: the wallet should be able to talk to the backend for exactly as long
 * as it is unlocked, no longer and no shorter.
 */
export async function writeBootstrapCache(entry: {
  fingerprint: string;
  backendUrl: string;
  accessToken: string;
  bootstrap: BootstrapAuthResult;
  sessionExpiresAtMs?: number;
}): Promise<void> {
  const { fingerprint: walletFingerprint, backendUrl, accessToken, bootstrap, sessionExpiresAtMs } = entry;
  const cachedAt = Date.now();
  // Default to the live session's expiry rather than the flat TTL. Reading it
  // here instead of threading it through every call site means a site that
  // forgets to pass it still gets the correct lifetime, which matters because
  // the failure mode is invisible until a user with a long auto-lock hits it.
  const sessionExpiry = sessionExpiresAtMs ?? (await readSessionExpiry());
  const record: BootstrapCacheEntry = {
    fingerprint: walletFingerprint,
    backendUrl,
    accessToken,
    bootstrap: withoutNewWalletAdmission(bootstrap),
    cachedAt,
    expiresAtMs: sessionExpiry ?? cachedAt + BOOTSTRAP_CACHE_FALLBACK_TTL_MS,
  };
  try {
    await sessionStorage.set(BOOTSTRAP_CACHE_KEY, record);
  } catch (e) {
    console.warn('[smirk] bootstrap cache write failed', e);
  }
}

/** Cached login state cannot replay the initial permission to create at tip. */
function withoutNewWalletAdmission(bootstrap: BootstrapAuthResult): BootstrapAuthResult {
  const projected = { ...bootstrap };
  if (projected.restoreState === 'new') delete projected.restoreState;
  return projected;
}

export async function clearBootstrapCache(): Promise<void> {
  try {
    await sessionStorage.remove(BOOTSTRAP_CACHE_KEY);
  } catch {
    /* best-effort */
  }
}
