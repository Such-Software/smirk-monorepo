import type { BootstrapAuthResult, Balances, Prices } from '@smirk/core';

/**
 * Live wallet session — auth bootstrap + fetched balances. Re-derived
 * whenever the user unlocks (or transitions empty → unlocked via
 * onboarding). Lives in module memory only; SW restart drops it and
 * the user re-enters their password. Per the audit posture: no
 * persistent JWT.
 */
export interface WalletSession {
  bootstrap: BootstrapAuthResult;
  balances: Balances | null;
  prices: Prices | null;
  /** Top-level fetch error (auth failure, network down). Per-asset errors live on AssetBalance. */
  error: string | null;
  /** True while a balance refresh is in flight, for UI spinners. */
  refreshing: boolean;
  /** When the latest balance fetch COMPLETED (even if some assets errored). Used
   *  by the scan-progress banner's "last refreshed" line. Distinct from
   *  {@link lastSuccessAt}, which only advances when fresh data actually landed. */
  refreshedAt: Date | null;
  /** Unix ms when balances FIRST went stale (a fetch errored while we held a
   *  good value), or null/absent when everything is fresh. Drives the "couldn't
   *  reach the backend for N minutes" warning; cleared on the next clean refresh. */
  balancesStaleSince?: number | null;
  /** Unix ms of the last refresh that actually returned fresh data (at least one
   *  attempted asset resolved without error). Anchors the escalating freshness
   *  cue's time-since-last-success clock; does NOT advance on a fully-failed
   *  refresh. Null/absent until the first fresh fetch lands this session. */
  lastSuccessAt?: number | null;
  /** True when the most recent COMPLETED refresh attempt failed to get any fresh
   *  data (threw, or every attempted asset errored). Drives the freshness cue's
   *  fail vs. succeed distinction; a single transient failure stays subtle until
   *  the time-since-`lastSuccessAt` thresholds escalate it. */
  lastRefreshFailed?: boolean;
}
