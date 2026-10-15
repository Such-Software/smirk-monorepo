/**
 * Older-address work that waits for this window's sign-in.
 *
 * Both jobs need the recovery phrase, so they belong to a full password unlock
 * (or an import), and both read authenticated wallet routes. Lock drops the
 * session token and the bootstrap cache, so after an unlock the token returns
 * only once a full network sign-in completes. Started from the unlock handler,
 * as they used to be, they raced that sign-in and lost on essentially every
 * unlock (v0.3.1 live run, 2026-10-15): the automatic check kept the refusals
 * as its one result, and the m/44' sweep convergence never read the old
 * address at all.
 *
 * `startSession` calls this once the session token is installed.
 */
import { api, type UnlockedWallet } from '@smirk/core';
import { convergeLegacySweep, type LegacySweepSummary } from './session-cache';
import { maybeAutoLegacyCheck } from './legacy-funds';

/** This unlock's sweep convergence. A new unlock is a new wallet object. */
const sweeps = new WeakMap<UnlockedWallet, Promise<LegacySweepSummary>>();

/**
 * Converge the legacy m/44' sweep once per unlock. The sweep may ask for the
 * password before it signs, and one unlock can see several sign-ins (the
 * upgrade wizard's, a sign-in retry, a backend switch); each must not ask again.
 * Call only while signed in.
 */
export function convergeLegacySweepOnce(wallet: UnlockedWallet): Promise<LegacySweepSummary> {
  let sweep = sweeps.get(wallet);
  if (!sweep) {
    sweep = convergeLegacySweep(wallet);
    sweeps.set(wallet, sweep);
  }
  return sweep;
}

export function startLegacyWorkAfterSignIn(wallet: UnlockedWallet): void {
  // A restored session has no phrase, and without a token every read is refused.
  if (!wallet.mnemonic || !api.getAccessToken()) return;
  void convergeLegacySweepOnce(wallet);
  // Once per wallet; guarded inside.
  void maybeAutoLegacyCheck(wallet);
}
