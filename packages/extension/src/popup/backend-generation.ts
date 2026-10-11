/**
 * Which backend this wallet window is on, as a generation counter, so work
 * started on one backend can tell that the window has since moved.
 *
 * Two things move a window:
 *
 *   - This window switches backend (Settings, or the bootstrap-error screen's
 *     escape). It drops its own session and re-bootstraps; the generation
 *     advances so a sign-in or balance fetch still running from before the
 *     switch stops instead of writing the old backend's token, cache or numbers
 *     over the new session.
 *   - ANOTHER context switches or resets the backend. `bootBackendSelection`
 *     re-points this window's `api` and clears its capabilities and relay set,
 *     but the window's own state (the session with the old backend's user id,
 *     its capabilities, an open Messages subscription, the Feed's relay) is
 *     React state that survived: a second window kept polling the old
 *     backend's user id against the new one and kept reading and publishing on
 *     the old operator's relays. The generation advances and the wallet UI
 *     starts over on the new backend (see `BackendScopedApp` in index.tsx).
 */

let generation = 0;
const movedElsewhereListeners = new Set<() => void>();

/** This window switched backend itself. */
export function advanceBackendGeneration(): void {
  generation += 1;
}

/**
 * Another context moved this window's backend. Pass to
 * `bootBackendSelection`, which calls it after re-pointing this window's `api`.
 */
export function backendMovedElsewhere(): void {
  generation += 1;
  for (const listener of [...movedElsewhereListeners]) {
    try {
      listener();
    } catch (e) {
      console.error('[backend-generation] a listener failed after the backend moved', e);
    }
  }
}

/**
 * Boot this window's backend selection (`bootBackendSelection`) so that a
 * switch or reset made in another context moves this window too. The wallet
 * window used to boot it with no callback, so its `api` moved and nothing
 * else did.
 *
 * Resolves when the boot has applied the stored selection. A session waits
 * for that before it pins its backend: one pinned to the build default a
 * moment before the stored selection landed would stop at its first check,
 * with nothing to start it again.
 */
export function followBackendSelection(
  boot: (onMoved: () => void) => Promise<void> | void,
): Promise<void> {
  return Promise.resolve(boot(backendMovedElsewhere));
}

/** Run `listener` whenever another context moves this window's backend. */
export function onBackendMovedElsewhere(listener: () => void): () => void {
  movedElsewhereListeners.add(listener);
  return () => {
    movedElsewhereListeners.delete(listener);
  };
}

/** Work bound to the backend this window was on when it started. */
export interface BackendScope {
  /** The backend the work started on. */
  readonly url: string;
  /** False once the window moved: another backend, or a new generation. */
  current(): boolean;
}

/** Capture the backend `api` points at now, and this window's generation. */
export function backendScope(api: { getBaseUrl(): string }): BackendScope {
  const url = api.getBaseUrl();
  const startedIn = generation;
  return {
    url,
    current: () => generation === startedIn && api.getBaseUrl() === url,
  };
}
