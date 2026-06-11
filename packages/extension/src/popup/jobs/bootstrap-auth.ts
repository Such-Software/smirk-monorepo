/**
 * Popup-side wrapper for the `bootstrap-auth` background job.
 *
 * Drives the full SW-resident bootstrap pipeline:
 *
 *   1. Resolve any in-flight or recently-completed `bootstrap-auth`
 *      job for this wallet. The SW persists job state to
 *      `chrome.storage.session`, so a popup that mounts after a
 *      previous popup died mid-solve still finds the result here.
 *   2. If nothing is reusable, kick off a fresh job with a
 *      popup-computed BIP-137 signature. The signature is the one
 *      step the SW can't perform (it doesn't get the private key);
 *      everything downstream — checkRestore, PoW solve,
 *      extensionRegister — lives in the offscreen runner.
 *   3. Await the result via the long-lived port. Survives popup
 *      remount — re-subscribing to a still-running job picks up
 *      progress where it left off.
 *
 * Token freshness window: the backend allows 5 minutes of drift on
 * `signedTimestamp` (see `smirk-backend/src/api/auth.rs`). We treat
 * jobs older than ~4 minutes as un-reusable to keep some margin for
 * the network round-trip to register.
 */

import { jobs } from './';
import type { JobState } from '../../background/jobs/types';

const BOOTSTRAP_DEDUP_PREFIX = 'bootstrap-auth:';
const REUSE_WINDOW_MS = 4 * 60 * 1000;

export interface BootstrapJobResult {
  bootstrap: {
    userId: string;
    username?: string;
    isNew: boolean;
    xmrStartHeight?: number;
    wowStartHeight?: number;
  };
  accessToken: string;
}

/**
 * Run a full background bootstrap. Resolves with the access token
 * and `BootstrapAuthResult`-shaped data, or rejects if the SW pipe
 * is unreachable or the register call hard-fails. Soft network
 * failures inside the handler (e.g. PoW challenge fetch flake) are
 * recovered into a no-solution register that the backend treats as
 * legacy-client during the graceful-migration window.
 *
 * `fingerprint` is used both for dedup (so two overlapping popup
 * mounts don't race two bootstraps for the same wallet) and for
 * cache discovery on subsequent mounts.
 */
export async function runBootstrapInBackground(input: {
  fingerprint: string;
  keys: ReadonlyArray<{ asset: string; publicKey: string }>;
  signedTimestamp: number;
  signature: string;
}): Promise<BootstrapJobResult> {
  const dedupKey = `${BOOTSTRAP_DEDUP_PREFIX}${input.fingerprint}`;

  // ---- 1. Look for a reusable existing job ----
  const existing = await jobs.list({
    kind: 'bootstrap-auth',
    dedupKey,
  });

  // 1a. Recently-done job whose signature is still within the
  // backend's 5-minute drift window. Pick the most recent.
  const now = Date.now();
  const reusableDone = existing
    .filter(
      (j): j is JobState<'bootstrap-auth'> =>
        j.kind === 'bootstrap-auth' &&
        j.status === 'done' &&
        typeof j.finishedAt === 'number' &&
        now - j.finishedAt < REUSE_WINDOW_MS,
    )
    .sort(
      (a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0),
    )[0];
  if (reusableDone?.result) {
    return reusableDone.result;
  }

  // 1b. Still-running job. Attach to it via awaitJob — the SW's
  // dedup-on-start means even a *new* `start` here would point at
  // the same id, but going through awaitJob skips a needless RPC.
  const inflight = existing.find(
    (j) => j.status === 'running' || j.status === 'pending',
  );
  if (inflight) {
    return await jobs.awaitJob<'bootstrap-auth'>(inflight.id);
  }

  // ---- 2. Nothing reusable — start fresh ----
  const id = await jobs.start(
    'bootstrap-auth',
    input,
    { dedupKey },
  );
  return await jobs.awaitJob<'bootstrap-auth'>(id);
}
