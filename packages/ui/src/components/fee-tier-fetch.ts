/**
 * Fee fetching for the Send flow: a per-attempt timeout, a bounded number of
 * automatic retries, every rejection handled, and a final state the screen
 * can show with a Retry. Used for the BTC/LTC fee tiers on Compose and Review
 * and for the fee estimate Compose shows on the other coins.
 *
 * Why: Review refetches the tiers on mount so it never signs a stale rate, and
 * Send stays disabled until that rate lands. The refetch used to be a bare
 * `resolveFeeRates(assetId).then(...)`: nothing handled a rejection and
 * nothing ended a request that never answered. It was also keyed on the
 * callback's identity, and the popup passes a fresh closure on every session
 * write, so the writes around Continue restarted the request and threw away
 * answers that were already on their way.
 *
 * Giving up is only what the screen says; it never discards an answer. The
 * popup's own fee callback does not reject: when the fee service is down or
 * silent it resolves the floored fallback tiers once the API client's 30 s
 * abort fires, which is later than our last attempt times out. That fallback
 * must still enable Send, so a valid answer from any attempt is used until the
 * fetch is cancelled, even after `failed`, and Retry keeps the requests
 * already in flight.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { FeeTiers } from './SendWizard';

/** How long one request may take before the next attempt starts. */
export const FEE_TIER_ATTEMPT_TIMEOUT_MS = 8_000;
/** Pause before each automatic retry; its length bounds the retries. */
export const FEE_TIER_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];
/** The first request plus one per retry delay. */
export const FEE_TIER_MAX_ATTEMPTS = FEE_TIER_RETRY_DELAYS_MS.length + 1;
/**
 * How long Compose waits for a non-tier fee estimate before saying so. It is
 * asked once; Review's own estimate wait uses the same 12 s.
 */
export const FEE_ESTIMATE_TIMEOUT_MS = 12_000;

export type FeeFetchState<T> =
  /** `attempt` is 1 for the first request; higher while retrying. */
  | { status: 'loading'; attempt: number }
  | { status: 'ready'; value: T }
  /** Every attempt failed and none has answered yet; `error` is the last cause. */
  | { status: 'failed'; error: string };

export type FeeTierFetchState = FeeFetchState<FeeTiers>;

export interface FeeFetchTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FeeFetchOptions<T> {
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  timers?: FeeFetchTimers;
  /**
   * Check an answer before using it. Return why it is unusable (shown to the
   * user, and retried like any failure), or null to accept it.
   */
  check?: (value: T) => string | null;
}

export interface FeeFetchHandle {
  /** After this, `onState` is never called again and nothing escapes. */
  cancel(): void;
  /**
   * Start a new round of attempts. Requests already in flight stay eligible:
   * whichever valid answer lands first is used.
   */
  retry(): void;
}

const realTimers: FeeFetchTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function describeFailure(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  return 'the fee service failed without saying why';
}

/**
 * Fetch a fee value, reporting each state change through `onState`.
 *
 * A failure (rejection, synchronous throw, timeout, or an answer `check`
 * refuses) from the newest attempt schedules the next one until the retry
 * delays run out, then reports `failed`. The first valid answer from any
 * attempt is used and ends the fetch, whether it lands while a later attempt
 * is running or after `failed`.
 */
export function startFeeFetch<T>(
  load: () => Promise<T>,
  onState: (state: FeeFetchState<T>) => void,
  options: FeeFetchOptions<T> = {},
): FeeFetchHandle {
  const timeoutMs = options.timeoutMs ?? FEE_TIER_ATTEMPT_TIMEOUT_MS;
  const delays = options.retryDelaysMs ?? FEE_TIER_RETRY_DELAYS_MS;
  const timers = options.timers ?? realTimers;
  let cancelled = false;
  let answered = false;
  let issued = 0;
  // The request whose failure moves the round on; 0 between attempts and
  // after `failed`, when only a valid answer can change anything.
  let current = 0;
  // The single timer: the newest attempt's timeout, or the next retry delay.
  let pending: unknown = null;

  const open = () => !cancelled && !answered;

  const clearPending = () => {
    if (pending !== null) timers.clearTimeout(pending);
    pending = null;
  };

  const fail = (request: number, attempt: number, reason: string) => {
    if (!open() || request !== current) return;
    clearPending();
    current = 0;
    const delay = delays[attempt - 1];
    if (delay === undefined) {
      onState({ status: 'failed', error: reason });
      return;
    }
    onState({ status: 'loading', attempt: attempt + 1 });
    pending = timers.setTimeout(() => {
      pending = null;
      run(attempt + 1);
    }, delay);
  };

  const run = (attempt: number) => {
    if (!open()) return;
    const request = ++issued;
    current = request;
    let answer: Promise<T>;
    try {
      answer = Promise.resolve(load());
    } catch (e) {
      answer = Promise.reject(e);
    }
    pending = timers.setTimeout(() => {
      pending = null;
      fail(request, attempt, `the fee service did not answer within ${Math.round(timeoutMs / 1000)} s`);
    }, timeoutMs);
    answer.then(
      (value) => {
        if (!open()) return;
        let problem: string | null;
        try {
          problem = options.check ? options.check(value) : null;
        } catch (e) {
          problem = describeFailure(e);
        }
        if (problem !== null) {
          fail(request, attempt, problem);
          return;
        }
        answered = true;
        current = 0;
        clearPending();
        onState({ status: 'ready', value });
      },
      (e: unknown) => fail(request, attempt, describeFailure(e)),
    );
  };

  onState({ status: 'loading', attempt: 1 });
  run(1);
  return {
    cancel: () => {
      cancelled = true;
      clearPending();
    },
    retry: () => {
      if (!open()) return;
      clearPending();
      current = 0;
      onState({ status: 'loading', attempt: 1 });
      run(1);
    },
  };
}

export interface FeeFetch<T> {
  /** Null while disabled. Never a state that belongs to another `key`. */
  state: FeeFetchState<T> | null;
  /** Start a new round of attempts for the current `key`. */
  retry: () => void;
}

/**
 * Fetch for `key`, or stay idle while it is null. Only a change of `key`
 * restarts the fetch: `load` and `check` are read through refs at request
 * time, so a parent re-rendering with new closures neither restarts the
 * request nor discards its answer.
 *
 * The state is tied to the key it was fetched for. When the key changes, the
 * render that sees the new key reports `loading`, never the previous key's
 * answer, even before the new fetch has started.
 */
export function useFeeFetch<T>(
  key: string | null,
  load: () => Promise<T>,
  check?: (value: T) => string | null,
  options: Omit<FeeFetchOptions<T>, 'check'> = {},
): FeeFetch<T> {
  const loadRef = useRef(load);
  loadRef.current = load;
  const checkRef = useRef(check);
  checkRef.current = check;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const handleRef = useRef<FeeFetchHandle | null>(null);
  const [held, setHeld] = useState<{ key: string; state: FeeFetchState<T> } | null>(null);

  useEffect(() => {
    if (key === null) return;
    const handle = startFeeFetch(
      () => loadRef.current(),
      (state) => setHeld({ key, state }),
      {
        ...optionsRef.current,
        check: (value) => (checkRef.current ? checkRef.current(value) : null),
      },
    );
    handleRef.current = handle;
    return () => {
      handle.cancel();
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [key]);

  const retry = useCallback(() => handleRef.current?.retry(), []);
  const state: FeeFetchState<T> | null =
    key === null ? null : held !== null && held.key === key ? held.state : { status: 'loading', attempt: 1 };
  return { state, retry };
}

/** The BTC/LTC fee tiers for `assetId`, fetched while `key` is non-null. */
export function useFeeTierFetch(
  assetId: string,
  key: string | null,
  resolveFeeRates: (assetId: string) => Promise<FeeTiers>,
  check?: (tiers: FeeTiers) => string | null,
): FeeFetch<FeeTiers> {
  return useFeeFetch(key === null ? null : `${assetId}|${key}`, () => resolveFeeRates(assetId), check);
}
