/**
 * Session state: the typed store every screen reads from and writes to.
 *
 * "Session" here means the user-facing app lifetime, which means
 * different things per platform:
 *
 * - **Extension popup:** survives popup-close (data round-trips through
 *   `chrome.storage.session`), dies on browser-close.
 * - **Capacitor mobile:** survives backgrounding (data round-trips
 *   through Preferences with an ephemeral tier), dies on OS-level
 *   tombstone / app force-quit.
 * - **Tauri desktop:** survives window minimize/restore, dies on app
 *   quit.
 *
 * Sensitive form data (full address, password mid-typing) is *intended*
 * to disappear at session end; that's the right tier. Anything that
 * needs to survive longer (denomination, theme, custom RPC URLs) goes
 * through a separate persistent store: see `chromeLocalStorage()` in
 * [`./platform`] and the platform-specific equivalents.
 *
 * State migrations: when the schema changes, bump `CURRENT_VERSION`
 * and add a migration to [`MIGRATIONS`]. Never edit a published
 * shape in place.
 */

import { PlatformStorage } from './platform';
import type { PendingOutgoingTx } from './pending-outgoing';

// ============================================================================
// Schema
// ============================================================================

/** Bump on every breaking schema change; add a migration. */
export const CURRENT_VERSION = 5;

/**
 * The full session state shape. Every field is restorable on reload.
 *
 * Keep this small + flat. Per-feature state (active wizards, scroll
 * positions) lives under named keys so multiple screens can coexist
 * without colliding.
 */
export interface SessionState {
  version: number;

  /** Current route (which tab/screen is showing). See [`./route`]. */
  route: Route;

  /** Per-route scroll positions. Key = serialized route id. */
  scroll: Record<string, number>;

  /** Active wizard states, keyed by wizard id. See [`./wizards`]. */
  wizards: Record<string, WizardState>;

  /**
   * UI-mode flags + user preferences.
   * - `balanceHidden`: eye-icon mask (UI_DESIGN.md Principle 8).
   * - `denomination`: "USD" | "EUR" | "BTC" | "sat" | … (per-user
   *   preference; mirrored from `chrome.storage.local` so the chosen
   *   denomination survives browser close).
   * - `autoLockMinutes`: how long the wallet stays unlocked after the
   *   session ends (popup-close on extension, backgrounding on mobile,
   *   window-close on desktop). **Has security implications**: when
   *   > 0, the derived leaf keys and addresses (never the mnemonic or
   *   seed) are mirrored to the platform's ephemeral-keyed storage for
   *   the configured duration. `0` (default) = lock immediately at
   *   session end (the safe default). Values are normalised by
   *   `clampAutoLockMinutes`: any negative value, and anything above
   *   `AUTO_LOCK_MAX_MINUTES` (24 h), clamps to the 24 h cap.
   * - `theme`: id of the registered theme from `@smirk/ui/themes`.
   *   Unknown ids fall back to the default theme at apply time.
   */
  ui: {
    balanceHidden: boolean;
    denomination: string;
    autoLockMinutes: number;
    theme: string;
    /**
     * Asset ids the user has explicitly hidden via Settings → Assets.
     * Defaults to `[]`. UI surfaces (HomeTab, UnifiedBalance,
     * SendWizard, TipMaker, ReceiveScreen) filter the asset list by
     * `!hidden`; balance polling skips hidden assets to keep backend
     * round-trips proportional to what the user actually uses. The
     * AssetDetailScreen stays routable for hidden assets so direct
     * links + claim-notification flows still work.
     *
     * "Hidden" is a UI preference. The wallet still owns the keys
     * for hidden assets; hiding never destroys access. Claiming a
     * tip for a hidden asset auto-unhides it (claiming money is an
     * explicit "I want to see this" signal).
     */
    hiddenAssets: string[];
    /**
     * Sign-in flow grace, in seconds, for "lock every time"
     * (`autoLockMinutes === 0`). After the user unlocks inside a website's
     * approval window, the next approval windows from THAT site and THAT tab
     * skip the password for this long, so one sign-in or tip claim costs one
     * unlock. Every request still shows its approval screen. Memory only,
     * never renewed, cleared on lock, deny and tab close. Optional: absent
     * means the extension default (90 s); `0` turns it off.
     */
    dappFlowGraceSeconds?: number;
    /**
     * Check this seed's older Smirk addresses for funds once per wallet after
     * unlock (see `legacy-recovery`). Only reads addresses the server already
     * watches; scanning an address it does not know always takes an explicit
     * tap. Optional: absent means on; `false` turns the automatic check off.
     */
    legacyFundsAutoCheck?: boolean;
  };

  /**
   * In-flight outgoing sends. Each entry holds the txHash + amount +
   * fee returned from a successful broadcast/submit. Displayed
   * available balance subtracts these so the user gets immediate
   * feedback before the network scanner catches up. Entries age out
   * per-asset (see `./pending-outgoing`). Survives popup-close,
   * dies on browser-close: appropriate window for the use case.
   */
  pendingOutgoing: PendingOutgoingTx[];
}

export interface Route {
  /** Route id: `"home"`, `"home/asset/btc"`, `"swap"`, `"inbox/item/<id>"`, etc. */
  current: string;
  /** Optional route params, e.g. `{ assetId: "btc" }`. */
  params?: Record<string, unknown>;
}

export interface WizardState {
  /** Zero-based step index in the wizard. */
  step: number;
  /** Collected field values so far. Schema is per-wizard; opaque here. */
  fields: Record<string, unknown>;
  /** When the wizard started. Used for staleness checks (e.g. swap-rate refresh). */
  startedAt: number;
}

// ============================================================================
// Defaults + migrations
// ============================================================================

export const DEFAULT_SESSION_STATE: SessionState = {
  version: CURRENT_VERSION,
  route: { current: 'home' },
  scroll: {},
  wizards: {},
  ui: {
    balanceHidden: false,
    denomination: 'USD',
    autoLockMinutes: 0, // safe default: lock immediately at session end
    theme: 'default',
    hiddenAssets: [], // every registered asset visible by default
  },
  pendingOutgoing: [],
};

/**
 * Per-version migration. Each entry takes the state at version N and
 * returns the state at version N+1. The sequence runs from the
 * stored `version` up to `CURRENT_VERSION`.
 *
 * Add new entries, never edit existing ones: once a version has
 * shipped to users, its migration logic is load-bearing.
 *
 * @example
 * ```ts
 * MIGRATIONS[1] = (s: SessionStateV1): SessionStateV2 => ({
 *   ...s,
 *   version: 2,
 *   ui: { ...s.ui, theme: 'dark' },
 * });
 * ```
 */
export type Migration<TFrom = unknown, TTo = unknown> = (state: TFrom) => TTo;

export const MIGRATIONS: Record<number, Migration> = {
  // v1 → v2: add `ui.autoLockMinutes` (default 0 = lock immediately).
  1: (s) => {
    const prev = s as SessionState;
    return {
      ...prev,
      version: 2,
      ui: { ...prev.ui, autoLockMinutes: 0 },
    } satisfies SessionState;
  },
  // v2 → v3: add `ui.theme` (default 'default' = current Smirk dark).
  2: (s) => {
    const prev = s as SessionState;
    return {
      ...prev,
      version: 3,
      ui: { ...prev.ui, theme: 'default' },
    } satisfies SessionState;
  },
  // v3 → v4: add `pendingOutgoing` for sender-side in-flight tracking.
  3: (s) => {
    const prev = s as Omit<SessionState, 'pendingOutgoing'>;
    return {
      ...prev,
      version: 4,
      pendingOutgoing: [],
    } satisfies SessionState;
  },
  // v4 → v5: add `ui.hiddenAssets` (default []). Existing wallets
  // come out the other side with every registered asset visible;
  // the upgrade is a no-op for any user who's been using v0.3.0+.
  4: (s) => {
    const prev = s as SessionState;
    return {
      ...prev,
      version: 5,
      ui: { ...prev.ui, hiddenAssets: [] },
    } satisfies SessionState;
  },
};

/** Apply migrations in order to bring `raw` up to `CURRENT_VERSION`. */
export function migrate(raw: unknown): SessionState {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SESSION_STATE };
  }
  let state = raw as { version?: number };

  // Unversioned legacy state: accept as v0 and let migrations fill in.
  let version = typeof state.version === 'number' ? state.version : 0;

  // Stored state is from a future version (downgrade scenario, or
  // multiple Smirk installs at different versions writing to the same
  // storage). Reset rather than try to forward-compat; ephemeral
  // state loss is safe: wallet seed lives elsewhere.
  if (version > CURRENT_VERSION) {
    return { ...DEFAULT_SESSION_STATE };
  }

  while (version < CURRENT_VERSION) {
    const next = MIGRATIONS[version];
    if (!next) {
      // No migration defined; reset to defaults rather than corrupt the
      // running app. Same safe-fallback rationale as the version-too-new
      // path above.
      return { ...DEFAULT_SESSION_STATE };
    }
    state = next(state) as { version?: number };
    version = typeof state.version === 'number' ? state.version : version + 1;
  }

  // Final shape sanity: fill in defaults for any missing fields a
  // partial migration left behind.
  return { ...DEFAULT_SESSION_STATE, ...(state as Partial<SessionState>) };
}

// ============================================================================
// Store
// ============================================================================

// Storage key kept as legacy `smirk:popup-state` for backward
// compatibility with any pre-rename data already written by alpha
// builds. The value is just an identifier; semantics are session-state.
const STORAGE_KEY = 'smirk:popup-state';

/**
 * Own writes remembered while storage may still report them. A burst longer
 * than this (writes issued faster than storage answers) forgets the oldest,
 * which a late read would then mistake for another window's state.
 */
const MAX_OWN_WRITES = 64;

/**
 * Field every stored state carries naming the store instance and the write
 * that produced it. It lives only in storage: reads drop it before the state
 * reaches the cache, and every write replaces it.
 */
const WRITE_STAMP_FIELD = 'writeStamp';

/** A random id for one store instance, so two windows never share stamps. */
function newWriterId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A stored session state without its write stamp. Anything that is not a
 * plain object is returned as it is, for `migrate` to judge.
 */
export function withoutWriteStamp(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !(WRITE_STAMP_FIELD in raw)) return raw;
  const { [WRITE_STAMP_FIELD]: _stamp, ...state } = raw as Record<string, unknown>;
  return state;
}

/** The state a stored value holds: defaults when nothing is stored. */
function fromStored(raw: unknown): SessionState {
  return raw === null ? { ...DEFAULT_SESSION_STATE } : migrate(withoutWriteStamp(raw));
}

/**
 * JSON with every object's keys in sorted order, so two encodings of one state
 * compare equal. chrome.storage returns objects with their keys sorted, not in
 * the order they were written, so a plain `JSON.stringify` of a read never
 * matched the same state as this store wrote it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

// ----------------------------------------------------------------------------
// Cross-window lock
// ----------------------------------------------------------------------------

/**
 * Runs a task while no other window of this origin runs one under the same
 * name. Every page of one extension shares an origin, so `navigator.locks`
 * serializes the popup, a pop-out, a tab and an approval window.
 */
export interface CrossWindowLock {
  run<T>(name: string, task: () => Promise<T>): Promise<T>;
}

/** How long an update waits for another window's before going ahead unlocked. */
const LOCK_WAIT_MS = 5_000;

/** The Web Locks API as a {@link CrossWindowLock}, or null where it is absent. */
export function webLocks(): CrossWindowLock | null {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (!locks || typeof locks.request !== 'function') return null;
  return {
    async run<T>(name: string, task: () => Promise<T>): Promise<T> {
      let granted = false;
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(LOCK_WAIT_MS)
          : undefined;
      try {
        return await locks.request(name, signal ? { signal } : {}, () => {
          granted = true;
          return task();
        });
      } catch (e) {
        if (granted) throw e;
        // Another window has held the lock for seconds (a hung write). A late
        // update beats a UI that stops saving.
        console.warn('[session-state] went ahead without the cross-window lock:', e);
        return task();
      }
    },
  };
}

/** What `update()` runs: it may change the state it is given, or return a new one. */
type Mutator = (state: SessionState) => void | SessionState | Promise<void | SessionState>;

/**
 * Typed reactive store for the session state. Wraps a [`PlatformStorage`]
 * backend with:
 *
 * - In-memory cache (avoids a round-trip per read)
 * - Atomic update via `update(fn)` (load-mutate-save)
 * - Subscriber notifications when other contexts (extension pop-out,
 *   second window, etc.) write to the same storage
 *
 * Framework-agnostic: exposes `subscribe(listener)` so any UI layer
 * can wire it up. The Preact hooks live in `@smirk/ui/state`.
 *
 * Windows share one stored state, and storage offers no compare-and-swap.
 * Under a lock every window of the extension shares (`navigator.locks`), an
 * update reads storage, runs its mutator on what it read and writes the
 * result, so it never writes over a state it has not seen. Another window's
 * change is kept even when it lands between two of this window's updates,
 * before this window has read it: a send recorded by a dapp approval window
 * while the popup was writing used to be lost that way. Without the lock (a
 * runtime that lacks it) an update runs on this window's cache and writes the
 * whole result: one window's state, never pieces of two, and when two windows
 * write within the same few milliseconds one change can be lost.
 */
export class SessionStateStore {
  private cached: SessionState | null = null;
  private readonly listeners = new Set<(state: SessionState) => void>();
  private readonly platformUnsub: () => void;

  /**
   * Canonical JSON ({@link canonicalJson}) of this store's own writes that
   * storage may still report back, oldest first. A change notification is
   * followed by a read, and that read can answer with ANY of these, not only
   * the newest: chrome.storage.local announces a write to the writing page
   * before the write's promise settles, so the read issued from the
   * announcement of write N is answered before write N+1 is applied, after
   * N+1 has already been issued. Adopting such a read as another window's
   * change put an older state back into the cache, and the next update built
   * on it: the Swap tab's "Open Send" lost its Send draft that way (live run
   * 2026-10-10). Pruned up to the newest write a read has returned.
   *
   * Each entry includes its write stamp ({@link writerId} and
   * {@link writeSeq}), so it matches only the exact write this store made.
   * Matching content alone mistook another window's state for an echo
   * whenever it equalled one of ours: a window that set auto-lock to an hour
   * and back to "every time" restored this window's earlier state exactly,
   * this window ignored it, kept the hour, and wrote it back.
   */
  private ownWrites: string[] = [];

  /** Names this store instance in the stamp of every write it makes. */
  private readonly writerId = newWriterId();

  /** Number of writes this store has made; the newest write's stamp ends in it. */
  private writeSeq = 0;

  /** `save()` calls whose storage write has not settled yet. */
  private writesInFlight = 0;

  /**
   * Another window's state was read while our own writes were in flight.
   * Those writes may land after it, so it is not adopted then; storage is read
   * again once they have settled.
   */
  private resyncAfterWrites = false;

  /**
   * Promise-chain mutex serializing every `update()` call. Without it,
   * two near-simultaneous updates both read the same cached snapshot,
   * each mutate an independent JSON-deep-cloned draft, then race to
   * `save()`, and the later write silently clobbers the earlier one.
   * Dogfooded 2026-06-13 by the Trocador swap "Open Send → pre-filled"
   * click handler firing two concurrent `store.update`s and losing the
   * prefill payload to the trocador-wizard step write. The mutex makes
   * every caller observe a consistent load → mutate → save cycle.
   * Callers that only `load()` / `save()` bypass it intentionally:
   * single-shot writes don't need ordering with each other.
   */
  private updateChain: Promise<unknown> = Promise.resolve();

  /**
   * @param lock serializes updates with the other windows; the Web Locks API
   *   by default, absent where the runtime has none.
   */
  constructor(
    private readonly storage: PlatformStorage,
    private readonly key: string = STORAGE_KEY,
    private readonly lock: CrossWindowLock | null = webLocks(),
  ) {
    // Listen for cross-context writes (e.g. extension pop-out window
    // updating state while the popup is open, or a Tauri second window).
    // Writes that originated here are skipped, including older ones.
    this.platformUnsub = this.storage.subscribe((changedKey) => {
      if (changedKey !== this.key) return;
      this.syncFromStorage();
    });
  }

  /**
   * Read storage after a change notification and adopt what it holds when it
   * is another window's write. Never adopts one of our own writes (the cache
   * already holds the newest of them), and never another window's state while
   * our own writes are still landing: storage is read again after them.
   */
  private syncFromStorage(): void {
    void this.storage
      .get<unknown>(this.key)
      .then((raw) => {
        // A payload that cannot be serialized (circular, corrupt) is not ours.
        let incoming: string | null = null;
        try {
          incoming = raw === null ? null : canonicalJson(raw);
        } catch {
          incoming = null;
        }
        if (incoming !== null && this.isOwnWrite(incoming)) return;
        if (this.writesInFlight > 0) {
          this.resyncAfterWrites = true;
          return;
        }
        const next = fromStored(raw);
        this.cached = next;
        for (const l of this.listeners) l(next);
      })
      .catch((e) => {
        // A failed cross-context sync must not become an unhandled rejection;
        // the cache stays as-is until the next read.
        console.warn('[session-state] cross-context sync failed:', e);
      });
  }

  /** True when `json` is one of our own writes; forgets the ones before it. */
  private isOwnWrite(json: string): boolean {
    const at = this.ownWrites.indexOf(json);
    if (at < 0) return false;
    // Storage has reached this write, so no later read returns an earlier one.
    this.ownWrites.splice(0, at);
    return true;
  }

  /**
   * Read the current state. Loads from storage on first call; caches afterward.
   *
   * State cached while the read is in flight (a save, a cross-context sync) is
   * newer than what the read returns, and wins. Before, a first read answering
   * late replaced that newer cache with what storage held when it was issued,
   * and the next `update()` saved the stale state back: a relaunch lost its
   * launch-time write that way.
   */
  async load(): Promise<SessionState> {
    if (this.cached) return this.cached;
    const raw = await this.storage.get<unknown>(this.key);
    this.cached ??= fromStored(raw);
    return this.cached;
  }

  /**
   * Replace the entire state. Most callers want [`update`] instead.
   *
   * Storage receives the state with a stamp naming this store and this write
   * (see {@link ownWrites}); the cache and every listener get it without one.
   */
  async save(state: SessionState): Promise<void> {
    const clean = withoutWriteStamp(state) as SessionState;
    this.writeSeq += 1;
    const stored = { ...clean, [WRITE_STAMP_FIELD]: `${this.writerId}:${this.writeSeq}` };
    const json = canonicalJson(stored);
    this.cached = clean;
    this.ownWrites.push(json);
    if (this.ownWrites.length > MAX_OWN_WRITES) this.ownWrites.splice(0, this.ownWrites.length - MAX_OWN_WRITES);
    this.writesInFlight += 1;
    try {
      await this.storage.set(this.key, stored);
    } finally {
      this.writesInFlight -= 1;
      if (this.writesInFlight === 0 && this.resyncAfterWrites) {
        this.resyncAfterWrites = false;
        this.syncFromStorage();
      }
    }
    for (const l of this.listeners) l(clean);
  }

  /**
   * Atomically read-modify-write the state. The mutator may mutate
   * the passed object directly (it's a fresh copy) or return a new
   * shape; both are handled.
   *
   * Serialized via `updateChain`: concurrent callers queue and run
   * one-at-a-time so each load → mutate → save observes the writes
   * of every prior `update()`. Mutator throws propagate to the
   * caller but don't break the chain: the next queued update runs
   * with the pre-throw state (no partial write).
   *
   * An update that changes nothing writes nothing. Every balance refresh
   * runs one, focus and visibility refreshes included, and a write there
   * saved this window's whole cached state back over storage: a change
   * another window had just made, announced but not yet read here, was
   * reverted in every window.
   *
   * Under the cross-window lock the mutator gets what storage holds, not
   * this window's cache, and the lock is held until its write settles: a
   * check the mutator makes holds for the state it replaces, whatever another
   * window saved a moment before. Keep mutators synchronous; one that waits
   * holds up every window's updates.
   */
  async update(mutator: Mutator): Promise<SessionState> {
    const run = (): Promise<SessionState> =>
      this.lock
        ? this.lock.run(`smirk:session-state:${this.key}`, async () => this.apply(await this.readCurrent(), mutator))
        : this.load().then((current) => this.apply(current, mutator));
    const next = this.updateChain.then(run, run);
    // Keep the chain alive across rejections so one failing mutator
    // doesn't strand all subsequent queued updates. The chain just
    // tracks "the previous update has settled (success OR failure)";
    // it never observes the value.
    this.updateChain = next.catch(() => {});
    return next;
  }

  /** Run `mutator` on a copy of `current` and write the result, unless it changed nothing. */
  private async apply(current: SessionState, mutator: Mutator): Promise<SessionState> {
    const draft: SessionState = JSON.parse(JSON.stringify(current));
    const result = await mutator(draft);
    const next = (result === undefined ? draft : result) as SessionState;
    if (canonicalJson(next) === canonicalJson(current)) return next;
    await this.save(next);
    return next;
  }

  /** What storage holds now, or the cache when it cannot be read. */
  private async readCurrent(): Promise<SessionState> {
    try {
      const raw = await this.storage.get<unknown>(this.key);
      if (raw !== null) return fromStored(raw);
    } catch (e) {
      console.warn('[session-state] storage could not be read; the update goes over the cached state:', e);
    }
    return this.cached ?? { ...DEFAULT_SESSION_STATE };
  }

  /**
   * Reset to defaults. Useful for tests + a "clear local UI state"
   * settings option.
   */
  async reset(): Promise<SessionState> {
    return this.save({ ...DEFAULT_SESSION_STATE }).then(() => ({ ...DEFAULT_SESSION_STATE }));
  }

  /**
   * Subscribe to state changes: fires after every write (local or
   * cross-context). Returns an unsubscribe function.
   */
  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Tear down the cross-context listener. Called by tests. */
  destroy(): void {
    this.platformUnsub();
    this.listeners.clear();
  }
}
