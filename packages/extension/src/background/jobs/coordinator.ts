/**
 * Service-worker-side job coordinator.
 *
 * Lifecycle:
 *
 *   Popup ─ port ─► SW.coordinator ─chrome.offscreen─► Offscreen runner
 *                       │                                   │
 *                       │◄────── progress / done ───────────┘
 *                       │
 *                       ├── persist state to chrome.storage.session
 *                       │
 *                       └── push event to subscribed ports
 *
 * When the popup port disconnects (popup closed), the running job
 * continues in the offscreen document; that's the whole point of
 * this system. Result lands in `chrome.storage.session`; the next
 * popup mount reads from there.
 *
 * Runtimes with no `chrome.offscreen` (Firefox MV3) run the handler in
 * THIS context instead of dispatching it; see `runJobLocally`. Every
 * downstream step (state writes, port events, dedup, GC) is identical,
 * so `awaitJob` / `subscribe` can't tell the two apart.
 *
 * State storage:
 *   - `chrome.storage.session.smirk:job:<id>` → `JobState`
 *   - `chrome.storage.session.smirk:job:dedup:<key>` → in-flight id
 *     for the dedup key (cleared when the job finishes).
 *
 * Completed-but-unconsumed jobs are GC'd after `RESULT_TTL_MS` so
 * the storage doesn't grow forever. Chrome already wipes
 * `storage.session` on browser close so the GC is just a within-
 * session cleanup.
 */

import type {
  JobContext,
  JobKind,
  JobState,
  JobStatus,
  JobsPortRequest,
  JobsPortResponse,
  OffscreenJobRequest,
  OffscreenJobResponse,
} from './types';
import {
  JOBS_PORT_NAME,
  JOBS_STORAGE_PREFIX,
  OFFSCREEN_PATH,
} from './types';
import { HANDLERS } from './handlers/registry';
import { api } from '@smirk/core';

const DEDUP_PREFIX = `${JOBS_STORAGE_PREFIX}dedup:`;
const RESULT_TTL_MS = 10 * 60 * 1000;

// ============================================================================
// Internal state
// ============================================================================

interface ConnectedPort {
  port: chrome.runtime.Port;
  /** Job ids this port is currently subscribed to (will receive
   *  `event` messages on state changes). */
  subscriptions: Set<string>;
}

const connectedPorts = new Set<ConnectedPort>();

// Job id allocator: simple monotonic counter. The SW restarts wipe
// this, but that's fine: chrome.storage.session also wipes on SW
// restart in practice.
let nextJobSerial = 1;
function allocateId(): string {
  // Stir in a non-deterministic suffix so two SW instances can't
  // collide if both somehow run (theoretically MV3 forbids this).
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString(36)
    .padStart(4, '0');
  const id = `job-${nextJobSerial++}-${rand}`;
  return id;
}

// ============================================================================
// Storage helpers
// ============================================================================

function storageKey(id: string): string {
  return `${JOBS_STORAGE_PREFIX}${id}`;
}

async function readState(id: string): Promise<JobState | undefined> {
  const result = await chrome.storage.session.get(storageKey(id));
  return result[storageKey(id)] as JobState | undefined;
}

async function writeState(state: JobState): Promise<void> {
  await chrome.storage.session.set({ [storageKey(state.id)]: state });
  // Push to subscribed ports.
  const event: JobsPortResponse = {
    type: 'event',
    subscriptionId: state.id,
    state,
  };
  for (const conn of connectedPorts) {
    if (conn.subscriptions.has(state.id)) {
      try {
        conn.port.postMessage(event);
      } catch {
        // Port may have disconnected mid-flight; harmless.
      }
    }
  }
}

async function readDedup(key: string): Promise<string | undefined> {
  const k = `${DEDUP_PREFIX}${key}`;
  const result = await chrome.storage.session.get(k);
  return result[k] as string | undefined;
}

async function writeDedup(key: string, id: string): Promise<void> {
  await chrome.storage.session.set({ [`${DEDUP_PREFIX}${key}`]: id });
}

async function clearDedup(key: string): Promise<void> {
  await chrome.storage.session.remove(`${DEDUP_PREFIX}${key}`);
}

// ============================================================================
// Offscreen lifecycle
// ============================================================================

let offscreenReady: Promise<void> | null = null;

/** `chrome.offscreen` is Chrome-only: Firefox MV3 does not implement it at
 *  all. Callers must branch on this rather than assume it exists. */
function offscreenApi(): typeof chrome.offscreen | undefined {
  return (chrome as unknown as { offscreen?: typeof chrome.offscreen })
    .offscreen;
}

async function ensureOffscreen(): Promise<void> {
  if (!offscreenReady) {
    const attempt = (async () => {
      // Newer Chrome surfaces `hasDocument`; older ones list contexts.
      const offscreen = offscreenApi();
      if (!offscreen) {
        throw new Error(
          'chrome.offscreen unavailable, likely a non-Chrome runtime',
        );
      }
      try {
        // Some Chrome versions reject creating a duplicate; ignore
        // the "already exists" error so we converge to ready.
        await offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: ['WORKERS' as chrome.offscreen.Reason],
          justification:
            'Run proof-of-work and other long compute outside the toolbar popup',
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        if (!message.toLowerCase().includes('only a single offscreen')) {
          // Re-throw genuine failures; tolerate "already exists".
          throw e;
        }
      }
    })();
    // Only a SUCCESSFUL attempt is worth memoizing. Keeping a rejected promise
    // here let one transient createDocument failure fail every later job until
    // the SW happened to restart, which for `bootstrap-auth` means the user
    // simply cannot sign in. Drop the memo so the next call retries.
    void attempt.catch(() => {
      if (offscreenReady === attempt) offscreenReady = null;
    });
    offscreenReady = attempt;
  }
  return offscreenReady;
}

/**
 * Run a job in the background context instead of an offscreen document.
 *
 * Firefox MV3 has no `chrome.offscreen`, and the only job kind is
 * `bootstrap-auth` (the whole registration/login pipeline), so refusing to run
 * without an offscreen document left Firefox unable to sign in at all. Its
 * background script is an event page with a full DOM and Workers, so the
 * handler runs there directly. What we give up is the offscreen document's
 * "survives SW eviction" property, which Chrome still gets.
 *
 * Mirrors offscreen/runner.ts: same registry lookup, same `JobContext`, same
 * progress/done/error reporting, except the results go straight into the state
 * writers rather than round-tripping through `chrome.runtime` messages. The
 * backend does not need forwarding either: this context IS the one whose
 * `api` singleton the offscreen request would have copied.
 */
function runJobLocally(id: string, kind: JobKind, input: unknown): void {
  const handler = HANDLERS[kind];
  if (!handler) {
    void onJobError(id, {
      code: 'UNKNOWN_KIND',
      message: `no handler registered for kind '${String(kind)}'`,
    });
    return;
  }

  const controller = new AbortController();
  const ctx: JobContext = {
    id,
    signal: controller.signal,
    reportProgress(progress) {
      void onJobProgress(id, progress);
    },
  };

  // Cast for the same reason runner.ts casts: `handler.run` is parameterised
  // on one `JobKind`, and we looked it up from the union at runtime.
  (handler.run as (input: unknown, ctx: JobContext) => Promise<unknown>)(
    input,
    ctx,
  )
    .then((result) => {
      void onJobDone(id, result);
    })
    .catch((e: unknown) => {
      void onJobError(id, {
        code: 'HANDLER_THREW',
        message: e instanceof Error ? e.message : String(e),
      });
    });
}

// ============================================================================
// Job start (the main entry point)
// ============================================================================

async function startJob<K extends JobKind>(args: {
  kind: K;
  input: unknown;
  dedupKey?: string;
}): Promise<string> {
  // Dedup: if a job with this key is already running, return it.
  if (args.dedupKey) {
    const existingId = await readDedup(args.dedupKey);
    if (existingId) {
      const existing = await readState(existingId);
      if (existing && (existing.status === 'pending' || existing.status === 'running')) {
        return existingId;
      }
      // Stale dedup mapping pointing at a finished or missing job:
      // clear it so we don't keep returning a useless id.
      await clearDedup(args.dedupKey);
    }
  }

  const id = allocateId();
  const initial: JobState<K> = {
    id,
    kind: args.kind,
    ...(args.dedupKey ? { dedupKey: args.dedupKey } : {}),
    status: 'pending',
    startedAt: Date.now(),
  };
  await writeState(initial);
  if (args.dedupKey) await writeDedup(args.dedupKey, id);

  // Move to 'running' once we hand off to whichever runner this browser has.
  const offscreenAvailable = offscreenApi() !== undefined;
  if (offscreenAvailable) {
    try {
      await ensureOffscreen();
    } catch (e: unknown) {
      // A failed handoff must not leave the job sitting at 'pending': the dedup
      // mapping written above outlives the throw, so the NEXT start for the same
      // key returns this id and `awaitJob` waits forever on a job nobody is
      // running. Record the failure (which releases the dedup key, wakes
      // subscribers, and schedules GC), then surface it to the caller as before.
      await onJobError(id, {
        code: 'OFFSCREEN_CREATE_FAILED',
        message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
  await writeState({ ...initial, status: 'running' });

  if (!offscreenAvailable) {
    // Firefox MV3 (no chrome.offscreen): run it here. See runJobLocally.
    runJobLocally(id, args.kind, args.input);
    return id;
  }

  const run: OffscreenJobRequest = {
    type: 'run',
    id,
    kind: args.kind,
    input: args.input,
    // Forward the SW's resolved backend so the offscreen auths against the user's
    // chosen backend (it can't read chrome.storage to resolve it itself).
    backend: { url: api.getBaseUrl(), apiStyle: api.getWalletApiStyle() },
  };
  // The offscreen runner is listening on chrome.runtime.onMessage;
  // its `sendMessage` reply isn't used (offscreen reports via its
  // own unsolicited messages; see runner.ts).
  chrome.runtime.sendMessage(run).catch((e: unknown) => {
    void onJobError(id, {
      code: 'OFFSCREEN_DISPATCH_FAILED',
      message: e instanceof Error ? e.message : String(e),
    });
  });

  return id;
}

// ============================================================================
// Result + error handlers (called by offscreen-message dispatcher
// installed in installJobsCoordinator below)
// ============================================================================

async function onJobProgress(id: string, progress: unknown): Promise<void> {
  const current = await readState(id);
  if (!current) return;
  await writeState({ ...current, progress });
}

async function onJobDone(id: string, result: unknown): Promise<void> {
  const current = await readState(id);
  if (!current) return;
  // Cast through `unknown` because TS narrows JobState<K> per-kind
  // and we don't know K statically inside the offscreen-result
  // dispatcher (the message carries the id, the storage carries the
  // kind, we marry them at runtime).
  const done = {
    ...current,
    status: 'done',
    finishedAt: Date.now(),
    result,
  } as unknown as JobState;
  await writeState(done);
  if (current.dedupKey) await clearDedup(current.dedupKey);
  scheduleResultGC(id);
}

async function onJobError(
  id: string,
  error: { code: string; message: string },
): Promise<void> {
  const current = await readState(id);
  if (!current) return;
  await writeState({
    ...current,
    status: 'error',
    finishedAt: Date.now(),
    error,
  });
  if (current.dedupKey) await clearDedup(current.dedupKey);
  scheduleResultGC(id);
}

function scheduleResultGC(id: string): void {
  setTimeout(() => {
    void chrome.storage.session.remove(storageKey(id));
  }, RESULT_TTL_MS);
}

// ============================================================================
// Public entry point: installs the message + port handlers on the SW
// ============================================================================

export function installJobsCoordinator(): void {
  // Offscreen result messages (unsolicited; from runner.ts).
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== 'object') return false;
    const msg = message as OffscreenJobResponse;
    if (msg.type === 'progress') {
      void onJobProgress(msg.id, msg.progress);
      return false;
    }
    if (msg.type === 'done') {
      void onJobDone(msg.id, msg.result);
      return false;
    }
    if (msg.type === 'error') {
      void onJobError(msg.id, msg.error);
      return false;
    }
    return false;
  });

  // Popup connections. One Port per popup mount; the popup uses it
  // for start / await / list / subscribe.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== JOBS_PORT_NAME) return;
    const conn: ConnectedPort = { port, subscriptions: new Set() };
    connectedPorts.add(conn);
    port.onDisconnect.addListener(() => {
      connectedPorts.delete(conn);
    });
    port.onMessage.addListener((rawMessage: unknown) => {
      void handlePortRequest(conn, rawMessage);
    });
  });
}

async function handlePortRequest(
  conn: ConnectedPort,
  raw: unknown,
): Promise<void> {
  if (!raw || typeof raw !== 'object') return;
  const req = raw as JobsPortRequest;
  try {
    switch (req.type) {
      case 'start': {
        const id = await startJob({
          kind: req.kind,
          input: req.input,
          ...(req.dedupKey ? { dedupKey: req.dedupKey } : {}),
        });
        ack(conn.port, req.requestId, id);
        return;
      }
      case 'cancel': {
        // No-op for now: the offscreen runner doesn't yet honour
        // remote aborts. Track for v0.3.x once a real flow needs it.
        ack(conn.port, req.requestId, true);
        return;
      }
      case 'list': {
        const all = await chrome.storage.session.get(null);
        const states: JobState[] = [];
        for (const [key, value] of Object.entries(all)) {
          if (!key.startsWith(JOBS_STORAGE_PREFIX) || key.startsWith(DEDUP_PREFIX)) {
            continue;
          }
          const state = value as JobState;
          if (req.kind && state.kind !== req.kind) continue;
          states.push(state);
        }
        ack(conn.port, req.requestId, states);
        return;
      }
      case 'subscribe': {
        conn.subscriptions.add(req.id);
        // Immediately push current state so the caller doesn't have
        // to call `list` + `subscribe` separately.
        const current = await readState(req.id);
        if (current) {
          const event: JobsPortResponse = {
            type: 'event',
            subscriptionId: req.id,
            state: current,
          };
          conn.port.postMessage(event);
        }
        ack(conn.port, req.requestId, true);
        return;
      }
      case 'unsubscribe': {
        conn.subscriptions.delete(req.id);
        ack(conn.port, req.requestId, true);
        return;
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const errResp: JobsPortResponse = {
      type: 'error',
      requestId: (req as { requestId?: number }).requestId ?? 0,
      message,
    };
    try {
      conn.port.postMessage(errResp);
    } catch {
      /* port gone */
    }
  }
}

function ack(
  port: chrome.runtime.Port,
  requestId: number,
  result: unknown,
): void {
  const message: JobsPortResponse = { type: 'ack', requestId, result };
  try {
    port.postMessage(message);
  } catch {
    /* port gone */
  }
}

// Status helper for handlers that need to know transitions.
export const __JOB_STATUSES__: readonly JobStatus[] = [
  'pending',
  'running',
  'done',
  'error',
];
