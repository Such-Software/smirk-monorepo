/**
 * Sign-in flow grace for wallets set to "lock every time".
 *
 * With `autoLockMinutes === 0` nothing unlocked survives a window, and every
 * dapp request opens a fresh approval window that starts locked. A website
 * sign-in is several requests (connect, sign, claim), so the user typed their
 * password two or three times for one action.
 *
 * The grace keeps the same material the auto-lock session cache keeps (derived
 * operation keys, never the phrase or seed) in memory-backed
 * `chrome.storage.session`, but bound to ONE origin and ONE tab and for at most
 * `DAPP_FLOW_GRACE_MAX_SECONDS`. Only the approval window reads it, and only
 * for a request whose verified origin and tab match; the main popup and Home
 * never see it, so they still lock immediately. Each request still shows its
 * approval screen: the grace saves the password, not the decision.
 *
 * Cleared on: expiry (fixed at the unlock, never renewed), any wallet lock
 * (lock epoch check plus `clearSessionCache`), deny in any approval window,
 * and the tab closing (background listener).
 */
import {
  parseSessionCache, reviveForSessionCache, serializeForSessionCache,
  derivedKeysUsable, restoreUnlockedFromCache, hasCompleteSigningMaterial,
  type SessionCachePayload, type UnlockedWallet,
} from '@smirk/core';
import { walletKeystore, sessionStorage } from './singletons';
import { ensureSessionSecrets } from './session-signing';
import { SESSION_LOCK_KEY, canRestoreLocalSession } from './session-lock';
import {
  DAPP_FLOW_GRACE_KEY,
  DAPP_FLOW_GRACE_MAX_SECONDS,
  type FlowScope,
} from './flow-grace-scope';

export {
  DAPP_FLOW_GRACE_KEY,
  DAPP_FLOW_GRACE_DEFAULT_SECONDS,
  DAPP_FLOW_GRACE_MAX_SECONDS,
  flowGraceSeconds,
  scopeOf,
  clearFlowGraceForTab,
} from './flow-grace-scope';
export type { FlowScope };

interface FlowGraceEntry {
  origin: string;
  tabId: number;
  expiresAtMs: number;
  lockId: string | null;
  cache: unknown;
}

async function currentLockId(): Promise<string | null> {
  return sessionStorage.get<string>(SESSION_LOCK_KEY);
}

export async function clearFlowGrace(): Promise<void> {
  await sessionStorage.remove(DAPP_FLOW_GRACE_KEY);
}

/**
 * Start the grace after a password unlock in an approval window. Only for
 * "lock every time": with a positive auto-lock the session cache already
 * covers the flow. An existing grace for the same scope keeps its original
 * expiry, so a busy flow cannot stretch it.
 */
export async function startFlowGrace(
  wallet: UnlockedWallet,
  scope: FlowScope,
  autoLockMinutes: number,
  graceSeconds: number,
  now: number = Date.now(),
): Promise<number | null> {
  if (autoLockMinutes !== 0 || graceSeconds <= 0) return null;
  const seconds = Math.min(graceSeconds, DAPP_FLOW_GRACE_MAX_SECONDS);
  if (!hasCompleteSigningMaterial(wallet)) return null;
  const existing = await sessionStorage.get<FlowGraceEntry>(DAPP_FLOW_GRACE_KEY);
  if (existing && existing.origin === scope.origin && existing.tabId === scope.tabId && now < existing.expiresAtMs) {
    return existing.expiresAtMs;
  }
  const lockId = await currentLockId();
  const secrets = await ensureSessionSecrets(wallet);
  const expiresAtMs = now + seconds * 1000;
  const cache: SessionCachePayload = {
    version: 3, _noMnemonic: true, fingerprint: wallet.fingerprint,
    keys: wallet.keys, addresses: wallet.addresses, sessionSecrets: secrets,
    lockId, expiresAtMs,
  };
  const entry: FlowGraceEntry = {
    origin: scope.origin, tabId: scope.tabId, expiresAtMs, lockId,
    cache: serializeForSessionCache(cache),
  };
  if (await currentLockId() !== lockId) return null;
  await sessionStorage.set(DAPP_FLOW_GRACE_KEY, entry);
  // A lock that landed during the write must not leave keys behind.
  if (await currentLockId() !== lockId) {
    await clearFlowGrace();
    return null;
  }
  return expiresAtMs;
}

/**
 * Restore the wallet for an approval window whose request matches the grace
 * scope. A request from another origin or tab is refused and leaves the grace
 * alone (it belongs to a different live flow); anything stale (expiry, lock
 * epoch, malformed, other wallet) is refused and cleared.
 */
export async function tryRestoreFlowGrace(
  scope: FlowScope | null,
  now: number = Date.now(),
): Promise<UnlockedWallet | null> {
  if (!scope || !canRestoreLocalSession()) return null;
  const entry = await sessionStorage.get<FlowGraceEntry>(DAPP_FLOW_GRACE_KEY);
  if (!entry) return null;
  if (entry.origin !== scope.origin || entry.tabId !== scope.tabId) return null;
  const generation = walletKeystore.captureSessionGeneration();
  const lockId = await currentLockId();
  if (now >= entry.expiresAtMs || entry.lockId !== lockId) {
    await clearFlowGrace();
    return null;
  }
  let cache: SessionCachePayload | null = null;
  try { cache = parseSessionCache(reviveForSessionCache(entry.cache)); } catch { /* malformed */ }
  if (!cache || cache.lockId !== lockId || !derivedKeysUsable(cache.keys)) {
    await clearFlowGrace();
    return null;
  }
  const state = await walletKeystore.getState();
  if (state.kind === 'empty' || state.keystore.fingerprint !== cache.fingerprint) {
    await clearFlowGrace();
    return null;
  }
  const wallet = restoreUnlockedFromCache({
    keys: cache.keys, addresses: cache.addresses, fingerprint: cache.fingerprint,
    sessionSecrets: cache.sessionSecrets, sessionExpiresAtMs: entry.expiresAtMs,
  });
  const unchangedEpoch = await currentLockId() === lockId;
  return walletKeystore.admitRestoredSession(
    wallet, generation, state.keystore.fingerprint,
    unchangedEpoch && canRestoreLocalSession() && Date.now() < entry.expiresAtMs,
  );
}
