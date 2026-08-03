import {
  SESSION_CACHE_KEY,
  reviveForSessionCache,
  parseSessionCache,
  derivedKeysUsable,
  restoreUnlockedFromCache,
  clampAutoLockMinutes,
  serializeForSessionCache,
  sweepLegacyBtcLtc,
  LEGACY_WALLET_KEY,
  type SessionCachePayload,
  type UnlockedWallet,
  type LegacySweepResult,
} from '@smirk/core';
import { storage, walletKeystore, sessionStorage } from './singletons';
import { cacheActiveNostrKeyForSession, clearCachedActiveNostrKey } from './nostr-vault';

/**
 * Try to restore a previously-cached unlocked wallet from
 * `chrome.storage.session`. Returns `null` if the cache is empty,
 * expired, malformed, or the wallet keystore's fingerprint doesn't
 * match (defensive: a re-imported wallet should NOT be auto-unlocked
 * from another wallet's cache).
 *
 * On a successful restore, writes the wallet back into
 * `walletKeystore.cached` so the rest of the app treats the state as
 * normally-unlocked.
 */
export async function tryRestoreSessionCache(): Promise<UnlockedWallet | null> {
  const stored = await sessionStorage.get(SESSION_CACHE_KEY);
  if (!stored) return null;
  // Revive `{__u8:hex}` (and recover a legacy numeric-object form) back to real
  // Uint8Arrays before validating — see serializeForSessionCache in keystore.ts.
  const raw = reviveForSessionCache(stored);

  // Parse via @smirk/core's `parseSessionCache` — rejects:
  //   - legacy v0.2.x { mnemonic, fingerprint, expiresAtMs } shape
  //   - missing version: 2 or missing _noMnemonic brand
  //   - any payload that re-introduces a `mnemonic` field
  // Any rejection drops the stored entry; the user re-enters their
  // password once. See keystore.ts SessionCachePayload.
  const entry = parseSessionCache(raw);
  if (!entry) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
  if (Date.now() >= entry.expiresAtMs) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
  // Cross-check fingerprint against the keystore on disk — if the
  // user re-imported a different wallet, the stale cache must not
  // unlock it.
  const ksState = await walletKeystore.getState();
  if (ksState.kind === 'empty' || ksState.keystore.fingerprint !== entry.fingerprint) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
  // Guard: if the key bytes didn't survive storage (revive couldn't recover real
  // Uint8Arrays), drop the cache and fall back to a password unlock instead of
  // restoring a wallet whose keys crash the auth bootstrap.
  if (!derivedKeysUsable(entry.keys)) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
  try {
    const wallet = restoreUnlockedFromCache({
      keys: entry.keys,
      addresses: entry.addresses,
      fingerprint: entry.fingerprint,
    });
    (walletKeystore as unknown as { cached: UnlockedWallet }).cached = wallet;
    return wallet;
  } catch {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    return null;
  }
}

/**
 * Persist the unlocked wallet's derived keys + addresses for
 * `minutes` of auto-unlock. Mnemonic is NEVER cached, so a disclosure
 * costs spend authority for the cache window and not the recovery
 * phrase; the full threat model is in the keystore.ts file header.
 *
 * `minutes` is clamped to `[0, AUTO_LOCK_MAX_MINUTES]`. The legacy
 * "Never" sentinel (negative / MAX_SAFE_INTEGER) was dropped in
 * v0.3.0; a stored legacy value self-heals to the 24h cap on read.
 */
export async function writeSessionCache(wallet: UnlockedWallet, minutes: number): Promise<void> {
  const clamped = clampAutoLockMinutes(minutes);
  if (clamped === 0) {
    await sessionStorage.remove(SESSION_CACHE_KEY);
    await clearCachedActiveNostrKey();
    return;
  }
  const expiresAtMs = Date.now() + clamped * 60_000;
  const entry: SessionCachePayload = {
    version: 2,
    _noMnemonic: true,
    fingerprint: wallet.fingerprint,
    keys: wallet.keys,
    addresses: wallet.addresses,
    expiresAtMs,
  };
  // Serialize Uint8Array key material to `{__u8:hex}` — chrome.storage.session
  // would otherwise flatten it to a numeric-keyed object that breaks signing on
  // restore ("private key must be hex string or Uint8Array").
  await sessionStorage.set(SESSION_CACHE_KEY, serializeForSessionCache(entry));
  // Also cache a NON-default active Nostr identity's key on the same lifetime so it
  // survives a warm resume (the default account-0 key already rides in wallet.keys).
  await cacheActiveNostrKeyForSession(wallet, expiresAtMs);
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
 * non-fatal: any failure just retries on the next unlock — the seed is already
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
    // it — the sweep then retries after a full password unlock.
    if (!wallet.mnemonic) return out;
    for (const asset of ['btc', 'ltc'] as const) {
      const r = await sweepLegacyBtcLtc(asset, wallet, storage);
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
