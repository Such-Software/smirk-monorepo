/**
 * Popup-side client for the background job system.
 *
 * Connects a long-lived `chrome.runtime.Port` to the SW's
 * coordinator and exposes a typed API: `start`, `await`, `list`,
 * `subscribe`, `cancel`.
 *
 * Across popup remounts: the SW + offscreen-document continue
 * running jobs. The popup reads `chrome.storage.session` via
 * `list({ kind, dedupKey })` to discover any in-flight jobs and
 * resume their await. The `dedupKey` lets the popup avoid starting
 * a second job for the same wallet/flow if one is already running.
 */

import {
  JOBS_PORT_NAME,
  type JobInput,
  type JobKind,
  type JobOutput,
  type JobState,
  type JobsPortRequest,
  type JobsPortResponse,
} from '../../background/jobs/types';

// ============================================================================
// Connection management
// ============================================================================

interface PendingRequest {
  resolve(result: unknown): void;
  reject(reason: unknown): void;
}

let connectedPort: chrome.runtime.Port | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();
const eventListeners = new Map<string, Set<(state: JobState) => void>>();

function connect(): chrome.runtime.Port {
  if (connectedPort) return connectedPort;
  const port = chrome.runtime.connect({ name: JOBS_PORT_NAME });
  connectedPort = port;
  port.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const msg = message as JobsPortResponse;
    if (msg.type === 'ack') {
      pendingRequests.get(msg.requestId)?.resolve(msg.result);
      pendingRequests.delete(msg.requestId);
    } else if (msg.type === 'error') {
      pendingRequests.get(msg.requestId)?.reject(new Error(msg.message));
      pendingRequests.delete(msg.requestId);
    } else if (msg.type === 'event') {
      const listeners = eventListeners.get(msg.subscriptionId);
      if (listeners) {
        for (const l of listeners) {
          try {
            l(msg.state);
          } catch (e) {
            console.error('[smirk-jobs] subscriber threw:', e);
          }
        }
      }
    }
  });
  port.onDisconnect.addListener(() => {
    connectedPort = null;
    // Reject everything in flight; the popup will reconnect on next
    // call. SW restart only happens between callsites in normal use.
    for (const [, p] of pendingRequests) {
      p.reject(new Error('background SW port disconnected'));
    }
    pendingRequests.clear();
  });
  return port;
}

/**
 * Distributive `Omit` over the discriminated `JobsPortRequest` union:
 * `Omit<Union, K>` collapses the union; we want every variant to
 * keep its discriminator. Spreading a single fresh `requestId` back
 * onto the result reconstructs the original variant.
 */
type WithoutRequestId<T> = T extends unknown ? Omit<T, 'requestId'> : never;

function sendRequest<T>(req: WithoutRequestId<JobsPortRequest>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const port = connect();
    const requestId = nextRequestId++;
    pendingRequests.set(requestId, {
      resolve: (v) => resolve(v as T),
      reject,
    });
    try {
      port.postMessage({ ...req, requestId } as JobsPortRequest);
    } catch (e) {
      pendingRequests.delete(requestId);
      reject(e);
    }
  });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start a new background job. Returns its id immediately; the job
 * runs in the offscreen document. Pass a `dedupKey` to merge with an
 * already-running job for the same key.
 */
export async function start<K extends JobKind>(
  kind: K,
  input: JobInput<K>,
  options?: { dedupKey?: string },
): Promise<string> {
  return await sendRequest<string>({
    type: 'start',
    kind,
    input,
    ...(options?.dedupKey ? { dedupKey: options.dedupKey } : {}),
  });
}

/**
 * Subscribe to a job's state changes. Listener fires once with the
 * current state and again on every transition. Returns an
 * unsubscribe.
 */
export function subscribe(
  id: string,
  listener: (state: JobState) => void,
): () => void {
  const set = eventListeners.get(id) ?? new Set();
  set.add(listener);
  eventListeners.set(id, set);
  void sendRequest({ type: 'subscribe', id });
  return () => {
    const current = eventListeners.get(id);
    if (current) {
      current.delete(listener);
      if (current.size === 0) {
        eventListeners.delete(id);
        void sendRequest({ type: 'unsubscribe', id });
      }
    }
  };
}

/**
 * Wait for a job to finish. Resolves with its result; rejects with
 * the recorded error. Safe across popup remounts: the await
 * subscribes to live state updates, and if the job has already
 * completed the initial subscription event delivers the result.
 */
export async function await_<K extends JobKind>(
  id: string,
): Promise<JobOutput<K>> {
  return new Promise<JobOutput<K>>((resolve, reject) => {
    const unsubscribe = subscribe(id, (state) => {
      if (state.status === 'done') {
        unsubscribe();
        resolve(state.result as JobOutput<K>);
      } else if (state.status === 'error') {
        unsubscribe();
        reject(
          Object.assign(new Error(state.error?.message ?? 'job failed'), {
            code: state.error?.code ?? 'UNKNOWN',
          }),
        );
      }
    });
  });
}

/**
 * List in-flight (or recently-completed) jobs. The dedupKey
 * filter is the typical use during popup remount discovery.
 */
export async function list(filter?: {
  kind?: JobKind;
  dedupKey?: string;
  statuses?: ReadonlyArray<JobState['status']>;
}): Promise<JobState[]> {
  const allStates = await sendRequest<JobState[]>({
    type: 'list',
    ...(filter?.kind ? { kind: filter.kind } : {}),
  });
  let states = allStates;
  if (filter?.dedupKey) {
    states = states.filter((s) => s.dedupKey === filter.dedupKey);
  }
  if (filter?.statuses) {
    const allowed = new Set(filter.statuses);
    states = states.filter((s) => allowed.has(s.status));
  }
  return states;
}

/** Request cancellation. Returns immediately; honour-by-handler. */
export async function cancel(id: string): Promise<void> {
  await sendRequest({ type: 'cancel', id });
}

// `await` is reserved, so the export is renamed.
export { await_ as awaitJob };
