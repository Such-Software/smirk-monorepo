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
  /** When the latest successful balance fetch completed. */
  refreshedAt: Date | null;
  /** Unix ms when balances FIRST went stale (a fetch errored while we held a
   *  good value), or null/absent when everything is fresh. Drives the "couldn't
   *  reach the backend for N minutes" warning; cleared on the next clean refresh. */
  balancesStaleSince?: number | null;
}
