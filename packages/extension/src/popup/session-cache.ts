import {
  SESSION_CACHE_KEY, parseSessionCache, reviveForSessionCache, serializeForSessionCache,
  derivedKeysUsable, restoreUnlockedFromCache, hasCompleteSigningMaterial,
  clampAutoLockMinutes, sweepLegacyBtcLtc, LEGACY_WALLET_KEY,
  type SessionCachePayload, type UnlockedWallet, type LegacySweepResult,
} from '@smirk/core';
import { storage, walletKeystore, sessionStorage } from './singletons';
import { clearCachedActiveNostrKey } from './nostr-vault';
import { ensureSessionSecrets } from './session-signing';
import { authorizeOperation, assertOperationSession } from './operation-auth';
import { SESSION_LOCK_KEY, canRestoreLocalSession, acknowledgePasswordUnlock } from './session-lock';

const SESSION_HANDOFF_KEY = 'smirk.session.handoff.v1';
export const HANDOFF_TTL_MS = 30_000;

export async function clearSessionCache(): Promise<void> {
  await Promise.all([
    sessionStorage.remove(SESSION_CACHE_KEY),
    sessionStorage.remove(SESSION_HANDOFF_KEY),
    clearCachedActiveNostrKey(),
  ]);
}

async function currentLockId(): Promise<string | null> {
  return sessionStorage.get<string>(SESSION_LOCK_KEY);
}

/** A late storage write must not leave revoked signing keys resident. */
async function finishCacheWrite(key: string, entry: SessionCachePayload, wallet: UnlockedWallet): Promise<void> {
  if (await currentLockId() === entry.lockId && hasCompleteSigningMaterial(wallet)) return;
  const current = await sessionStorage.get<{ lockId?: unknown; expiresAtMs?: unknown }>(key);
  // Do not clear a later session deliberately established after the lock.
  if (current?.lockId === entry.lockId && current.expiresAtMs === entry.expiresAtMs) {
    await sessionStorage.remove(key);
  }
  throw new Error('Wallet was locked while its session was being saved.');
}

/** Restore complete scoped keys only, preserving the original expiry. */
export async function tryRestoreSessionCache(): Promise<UnlockedWallet | null> {
  const generation = walletKeystore.captureSessionGeneration();
  const live = await walletKeystore.getState();
  if (live.kind === 'unlocked' && hasCompleteSigningMaterial(live.wallet)) {
    if (live.wallet.mnemonic && live.wallet.seed) acknowledgePasswordUnlock();
    if (canRestoreLocalSession()) return live.wallet;
  }
  if (!canRestoreLocalSession()) return null;
  const lockId = await currentLockId();
  for (const key of [SESSION_HANDOFF_KEY, SESSION_CACHE_KEY]) {
    const stored = await sessionStorage.get(key);
    if (!stored) continue;
    if (key === SESSION_HANDOFF_KEY) await sessionStorage.remove(key);
    let entry: SessionCachePayload | null = null;
    try { entry = parseSessionCache(reviveForSessionCache(stored)); } catch { /* malformed cache */ }
    if (!entry || Date.now() >= entry.expiresAtMs || entry.lockId !== lockId
      || (key === SESSION_HANDOFF_KEY && entry.sessionExpiresAtMs === undefined)
      || !derivedKeysUsable(entry.keys)) {
      await sessionStorage.remove(key);
      continue;
    }
    const state = await walletKeystore.getState();
    if (state.kind === 'empty' || state.keystore.fingerprint !== entry.fingerprint) {
      await sessionStorage.remove(key);
      continue;
    }
    const expiry = key === SESSION_HANDOFF_KEY ? entry.sessionExpiresAtMs : entry.expiresAtMs;
    if (expiry !== undefined && expiry !== null && Date.now() >= expiry) continue;
    const wallet = restoreUnlockedFromCache({
      keys: entry.keys, addresses: entry.addresses, fingerprint: entry.fingerprint,
      sessionSecrets: entry.sessionSecrets,
      ...(expiry !== undefined && expiry !== null ? { sessionExpiresAtMs: expiry } : {}),
    });
    // A concurrent explicit lock revokes even a cache read that began earlier.
    const unchangedEpoch = await currentLockId() === lockId;
    // The read above can finish while local lock publication is delayed or fails.
    // Admission rechecks the synchronous keystore generation, never only storage.
    return walletKeystore.admitRestoredSession(
      wallet, generation, state.keystore.fingerprint,
      unchangedEpoch && canRestoreLocalSession() && Date.now() < entry.expiresAtMs,
    );
  }
  await clearCachedActiveNostrKey();
  return null;
}

export async function readSessionExpiry(): Promise<number | null> {
  try {
    const raw = await sessionStorage.get<{ expiresAtMs?: unknown }>(SESSION_CACHE_KEY);
    const expiry = raw?.expiresAtMs;
    return typeof expiry === 'number' && Number.isFinite(expiry) && Date.now() < expiry ? expiry : null;
  } catch { return null; }
}

/** Write complete operation keys to memory-backed storage, never a phrase or seed. */
export async function writeSessionCache(wallet: UnlockedWallet, minutes: number): Promise<number | null> {
  const clamped = clampAutoLockMinutes(minutes);
  if (clamped === 0) {
    delete wallet.sessionExpiresAtMs;
    await clearSessionCache();
    return null;
  }
  const lockId = await currentLockId();
  const secrets = await ensureSessionSecrets(wallet);
  if (!hasCompleteSigningMaterial(wallet) || await currentLockId() !== lockId) {
    throw new Error('Wallet was locked before its session could be saved.');
  }
  const expiresAtMs = Date.now() + clamped * 60_000;
  const entry: SessionCachePayload = {
    version: 3, _noMnemonic: true, fingerprint: wallet.fingerprint,
    keys: wallet.keys, addresses: wallet.addresses, sessionSecrets: secrets,
    lockId, expiresAtMs,
  };
  wallet.sessionExpiresAtMs = expiresAtMs;
  await sessionStorage.set(SESSION_CACHE_KEY, serializeForSessionCache(entry));
  await finishCacheWrite(SESSION_CACHE_KEY, entry, wallet);
  await clearCachedActiveNostrKey();
  return expiresAtMs;
}

/** Transfer a complete window-only or grace-period session without renewing it. */
export async function writeSessionHandoff(wallet: UnlockedWallet): Promise<void> {
  const lockId = await currentLockId();
  const secrets = await ensureSessionSecrets(wallet);
  if (!hasCompleteSigningMaterial(wallet) || await currentLockId() !== lockId) {
    throw new Error('Wallet was locked before the new window could open.');
  }
  const sessionExpiresAtMs = wallet.sessionExpiresAtMs ?? null;
  if (sessionExpiresAtMs !== null && Date.now() >= sessionExpiresAtMs) throw new Error('Wallet session expired.');
  const entry: SessionCachePayload = {
    version: 3, _noMnemonic: true, fingerprint: wallet.fingerprint,
    keys: wallet.keys, addresses: wallet.addresses, sessionSecrets: secrets,
    lockId, sessionExpiresAtMs,
    expiresAtMs: Math.min(Date.now() + HANDOFF_TTL_MS, sessionExpiresAtMs ?? Infinity),
  };
  await sessionStorage.set(SESSION_HANDOFF_KEY, serializeForSessionCache(entry));
  await finishCacheWrite(SESSION_HANDOFF_KEY, entry, wallet);
}

/**
 * Convergent post-unlock sweep of legacy `m/44'` BTC/LTC funds to the v0.3
 * `m/84'` receive address. v0.2 used `m/44'`, so a migrated wallet's old coins
 * sit at an address it no longer watches; this moves them over.
 *
 * Gated on a legacy `walletState` still being present, so it only ever runs for
 * wallets that came from v0.2 (a fresh v0.3 wallet has no legacy state → no-op)
 * and stops once cleanup removes that state. `sweepLegacyBtcLtc` is itself
 * idempotent (durable per-asset txid record + empty-scan short-circuit), so
 * repeat calls across unlocks are cheap and never double-broadcast. Fully
 * non-fatal: any failure just retries on the next unlock; the seed is already
 * safe in the v0.3 keystore, this only relocates coins.
 */
/** What the sweep actually did, per asset, so callers can tell the user the
 *  truth instead of a fixed sentence. `null` = the sweep did not run at all. */
export interface LegacySweepSummary {
  btc: LegacySweepResult | null;
  ltc: LegacySweepResult | null;
  /** True when any asset actually broadcast a sweep on THIS call. */
  anySwept: boolean;
  /** True when the attempt threw, so nothing is known and it will retry. */
  errored: boolean;
}

export async function convergeLegacySweep(
  wallet: UnlockedWallet,
): Promise<LegacySweepSummary> {
  // Returns a summary rather than void: the migration done-screen used to state
  // "Funds swept to your new BTC/LTC addresses" unconditionally, including when
  // the broadcast failed, when there was nothing to sweep, and when the sweep
  // never ran because the seed was absent. Telling someone their money moved
  // when it did not is the worst kind of wrong, so the caller now gets facts.
  const out: LegacySweepSummary = { btc: null, ltc: null, anySwept: false, errored: false };
  try {
    // Only migrated-from-v0.2 wallets can have legacy m/44' funds.
    const legacy = await storage.get(LEGACY_WALLET_KEY);
    if (!legacy) return out;
    // Need the phrase to derive the m/44' key; a session-cache restore drops
    // it; the sweep then retries after a full password unlock.
    if (!wallet.mnemonic) return out;
    for (const asset of ['btc', 'ltc'] as const) {
      const r = await sweepLegacyBtcLtc(asset, wallet, storage, {
        authorize: () => authorizeOperation('send', wallet, `Move legacy ${asset.toUpperCase()} funds to your current wallet address`),
        assertActive: () => assertOperationSession(wallet),
      });
      out[asset] = r;
      if (r.status === 'swept') {
        out.anySwept = true;
        console.info(`[smirk] swept legacy ${asset} → m/84'`, r.txid);
      }
    }
  } catch (e) {
    out.errored = true;
    console.warn('[smirk] legacy BTC/LTC sweep failed (retries next unlock)', e);
  }
  return out;
}
