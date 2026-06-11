/**
 * Public types for the background job system.
 *
 * A "job" is a long-running task the popup wants to offload so it
 * survives popup close. The popup posts a `start` message; the SW
 * coordinator dispatches to a registered handler running inside an
 * offscreen document; the handler reports back through the SW. State
 * is persisted in `chrome.storage.session` so a remounted popup can
 * resume / read the result.
 *
 * Why this exists instead of inline async in the popup: MV3 toolbar
 * popups unmount on focus loss (alt-tab, screenshot, click outside),
 * killing every in-flight Promise. PoW solve (~1-3s of PBKDF2) is
 * the immediate motivator, but the same shape covers Grin slatepack
 * finalize, Trocador swap status polling, LWS catch-up rescan, etc.
 *
 * Adding a new job kind:
 *   1. Add the kind here to `JobKindMap` with its input/output types.
 *   2. Write a `JobHandler<Input, Output>` and export it.
 *   3. Register it in `handlers/registry.ts`.
 * The popup uses `jobs.start('your-kind', input)` and gets a typed
 * `JobOutput<'your-kind'>` back.
 */

// ============================================================================
// The registry of job kinds — extend this when adding new long-running flows
// ============================================================================

/**
 * Master mapping of `JobKind` → `{ input, output }`. The single source
 * of truth for what jobs exist and their I/O shapes. Type-safe
 * `start`, `await`, and `subscribe` rely on this map; any new job
 * kind starts here.
 */
export interface JobKindMap {
  /**
   * Full wallet bootstrap (the whole `@smirk/core.bootstrapAuth`
   * pipeline) executed in the background so popup close can't strand
   * a half-completed registration. Input includes the popup-computed
   * BIP-137 signature over `smirk-auth-${timestamp}` (which the SW
   * can't sign — it doesn't see the unlocked-wallet private key).
   * The handler does the rest: optional `checkRestore` for resume
   * heights, PoW solve, the `/auth/extension` POST. Output is the
   * access token + the `BootstrapAuthResult` shape the popup
   * expects.
   *
   * Survives popup close end-to-end: the popup that initiated may
   * die mid-solve, the SW completes the register anyway, the
   * `chrome.storage.session` job-state holds the access token until
   * the next popup mount picks it up via dedup-key lookup.
   */
  'bootstrap-auth': {
    input: {
      fingerprint: string;
      keys: ReadonlyArray<{ asset: string; publicKey: string }>;
      signedTimestamp: number;
      signature: string;
    };
    output: {
      bootstrap: {
        userId: string;
        username?: string;
        isNew: boolean;
        xmrStartHeight?: number;
        wowStartHeight?: number;
      };
      accessToken: string;
    };
  };
  // Future: add entries here as we port flows over.
  // 'grin-finalize': { input: { slate: string; ... }; output: { ... } };
  // 'swap-poll':    { input: { tradeId: string };    output: { ... } };
}

export type JobKind = keyof JobKindMap;
export type JobInput<K extends JobKind> = JobKindMap[K]['input'];
export type JobOutput<K extends JobKind> = JobKindMap[K]['output'];

// ============================================================================
// Job state — persisted to chrome.storage.session
// ============================================================================

/** Lifecycle of a single job. */
export type JobStatus = 'pending' | 'running' | 'done' | 'error';

/**
 * Snapshot of a job's current state. Stored in
 * `chrome.storage.session` keyed by `id`; the popup queries this on
 * remount to find any in-flight or completed work.
 */
export interface JobState<K extends JobKind = JobKind> {
  readonly id: string;
  readonly kind: K;
  /**
   * Optional dedup key — if `start` is called with the same key
   * while a matching job is still running, the existing job's id is
   * returned instead of allocating a new one. Typical key for PoW:
   * the wallet fingerprint (no point solving two challenges for the
   * same wallet at once).
   */
  readonly dedupKey?: string;
  readonly status: JobStatus;
  readonly startedAt: number;
  readonly finishedAt?: number;
  /** Handler-defined progress shape. UI may render it; the
   *  coordinator treats it as opaque. */
  readonly progress?: unknown;
  readonly result?: JobOutput<K>;
  readonly error?: { code: string; message: string };
}

// ============================================================================
// Handler contract — implemented in handlers/*.ts, dispatched from
// the offscreen runner
// ============================================================================

/**
 * Per-kind handler — pure async function from input to output. Runs
 * inside the offscreen document where Web Crypto and Workers are
 * available. The coordinator wraps it with persistence, cancellation,
 * and message dispatch; handlers stay narrow.
 *
 * Throw for terminal errors; the coordinator converts to `error`
 * status and surfaces the message to the popup. `ctx.signal` aborts
 * on `jobs.cancel(id)`.
 */
export interface JobHandler<K extends JobKind = JobKind> {
  readonly kind: K;
  run(input: JobInput<K>, ctx: JobContext): Promise<JobOutput<K>>;
}

/**
 * What a handler receives in addition to its `input`. Lets handlers
 * report streaming progress and respond to cancellation.
 */
export interface JobContext {
  readonly id: string;
  readonly signal: AbortSignal;
  reportProgress(p: unknown): void;
}

// ============================================================================
// Wire-format messages (popup ↔ SW, SW ↔ offscreen)
//
// Kept in this file because every layer references them and the
// `kind` discriminators must match exactly.
// ============================================================================

export const JOBS_PORT_NAME = 'smirk-jobs';
export const JOBS_STORAGE_PREFIX = 'smirk:job:';
export const OFFSCREEN_PATH = 'jobs-offscreen.html';

/** Messages the popup sends to the SW over its named Port. */
export type JobsPortRequest =
  | {
      type: 'start';
      requestId: number;
      kind: JobKind;
      input: unknown;
      dedupKey?: string;
    }
  | { type: 'cancel'; requestId: number; id: string }
  | { type: 'list'; requestId: number; kind?: JobKind }
  | { type: 'subscribe'; requestId: number; id: string }
  | { type: 'unsubscribe'; requestId: number; id: string };

/** Messages the SW sends back. `requestId` echoes; `event` is
 *  unsolicited (subscription updates). */
export type JobsPortResponse =
  | { type: 'ack'; requestId: number; result: unknown }
  | { type: 'error'; requestId: number; message: string }
  | { type: 'event'; subscriptionId: string; state: JobState };

/** Messages the SW sends to the offscreen runner. */
export type OffscreenJobRequest = {
  type: 'run';
  id: string;
  kind: JobKind;
  input: unknown;
};

/** Messages the offscreen runner sends back. */
export type OffscreenJobResponse =
  | { type: 'progress'; id: string; progress: unknown }
  | { type: 'done'; id: string; result: unknown }
  | { type: 'error'; id: string; error: { code: string; message: string } };
