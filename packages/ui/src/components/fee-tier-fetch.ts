/**
 * Fee-tier fetching for the Send flow: a per-attempt timeout, a bounded
 * number of automatic retries, every rejection handled, and a final state the
 * screen can show with a Retry.
 *
 * Why: Review refetches the tiers on mount so it never signs a stale rate, and
 * Send stays disabled until that rate lands. The refetch used to be a bare
 * `resolveFeeRates(assetId).then(...)`: a rejection escaped as an unhandled
 * rejection and left Send disabled with "loading…" forever, and a request
 * that never answered did the same. It was also keyed on the callback's
 * identity, and the popup passes a fresh closure on every session write, so
 * the writes around Continue restarted the request and threw away answers
 * that were already on their way.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { FeeTiers } from './SendWizard';

/** How long one request may take before it counts as failed. */
export const FEE_TIER_ATTEMPT_TIMEOUT_MS = 8_000;
/** Pause before each automatic retry; its length bounds the retries. */
export const FEE_TIER_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];
/** The first request plus one per retry delay. */
export const FEE_TIER_MAX_ATTEMPTS = FEE_TIER_RETRY_DELAYS_MS.length + 1;

export type FeeTierFetchState =
  /** `attempt` is 1 for the first request; higher while retrying. */
  | { status: 'loading'; attempt: number }
  | { status: 'ready'; tiers: FeeTiers }
  /** Every attempt failed; `error` is the last cause, for display. */
  | { status: 'failed'; error: string };

export interface FeeTierFetchTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FeeTierFetchOptions {
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  timers?: FeeTierFetchTimers;
  /**
   * Check an answer before using it. Return why it is unusable (shown to the
   * user, and retried like any failure), or null to accept it.
   */
  check?: (tiers: FeeTiers) => string | null;
}

const realTimers: FeeTierFetchTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function describeFailure(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  return 'the fee service failed without saying why';
}

/**
 * Fetch fee tiers, reporting each state change through `onState`. Returns a
 * cancel function: after it runs, `onState` is never called again and no
 * late answer or rejection escapes.
 *
 * A failure (rejection, synchronous throw, timeout, or an answer `check`
 * refuses) from the current attempt schedules the next one until the retry
 * delays run out, then reports `failed`. A success from any attempt still in
 * flight is used, so a slow first answer that lands during a retry is not
 * thrown away; nothing is accepted after the final `failed`.
 */
export function startFeeTierFetch(
  load: () => Promise<FeeTiers>,
  onState: (state: FeeTierFetchState) => void,
  options: FeeTierFetchOptions = {},
): () => void {
  const timeoutMs = options.timeoutMs ?? FEE_TIER_ATTEMPT_TIMEOUT_MS;
  const delays = options.retryDelaysMs ?? FEE_TIER_RETRY_DELAYS_MS;
  const timers = options.timers ?? realTimers;
  let stopped = false;
  let current = 0;
  let pending: unknown = null;

  const clearPending = () => {
    if (pending !== null) timers.clearTimeout(pending);
    pending = null;
  };

  const finish = (state: FeeTierFetchState) => {
    if (stopped) return;
    stopped = true;
    clearPending();
    onState(state);
  };

  const fail = (attempt: number, reason: string) => {
    // Only the newest attempt decides; an older one already timed out.
    if (stopped || attempt !== current) return;
    clearPending();
    const delay = delays[attempt - 1];
    if (delay === undefined) {
      finish({ status: 'failed', error: reason });
      return;
    }
    // Mark the attempt as spent so its own late failure is ignored.
    current = 0;
    onState({ status: 'loading', attempt: attempt + 1 });
    pending = timers.setTimeout(() => {
      pending = null;
      run(attempt + 1);
    }, delay);
  };

  const run = (attempt: number) => {
    if (stopped) return;
    current = attempt;
    let answer: Promise<FeeTiers>;
    try {
      answer = Promise.resolve(load());
    } catch (e) {
      answer = Promise.reject(e);
    }
    pending = timers.setTimeout(() => {
      pending = null;
      fail(attempt, `the fee service did not answer within ${Math.round(timeoutMs / 1000)} s`);
    }, timeoutMs);
    answer.then(
      (tiers) => {
        if (stopped) return;
        const problem = options.check ? options.check(tiers) : null;
        if (problem !== null) fail(attempt, problem);
        else finish({ status: 'ready', tiers });
      },
      (e: unknown) => fail(attempt, describeFailure(e)),
    );
  };

  onState({ status: 'loading', attempt: 1 });
  run(1);
  return () => {
    stopped = true;
    clearPending();
  };
}

export interface FeeTierFetch {
  /** Null while disabled. */
  state: FeeTierFetchState | null;
  /** Start again from the first attempt. */
  retry: () => void;
}

/**
 * React to `assetId`, `enabled` and `key` only. The callbacks are read through
 * refs at request time, so a parent re-rendering with new closures neither
 * restarts the request nor discards its answer.
 */
export function useFeeTierFetch(
  assetId: string,
  enabled: boolean,
  resolveFeeRates: (assetId: string) => Promise<FeeTiers>,
  check?: (tiers: FeeTiers) => string | null,
  key = '',
): FeeTierFetch {
  const resolveRef = useRef(resolveFeeRates);
  resolveRef.current = resolveFeeRates;
  const checkRef = useRef(check);
  checkRef.current = check;
  const [state, setState] = useState<FeeTierFetchState | null>(
    enabled ? { status: 'loading', attempt: 1 } : null,
  );
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    return startFeeTierFetch(() => resolveRef.current(assetId), setState, {
      check: (tiers) => (checkRef.current ? checkRef.current(tiers) : null),
    });
  }, [assetId, enabled, key, run]);

  const retry = useCallback(() => setRun((n) => n + 1), []);
  return { state, retry };
}
