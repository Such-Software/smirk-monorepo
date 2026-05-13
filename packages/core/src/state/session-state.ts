/**
 * Session state — the typed store every screen reads from and writes to.
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
 * to disappear at session end — that's the right tier. Anything that
 * needs to survive longer (denomination, theme, custom RPC URLs) goes
 * through a separate persistent store — see `chromeLocalStorage()` in
 * [`./platform`] and the platform-specific equivalents.
 *
 * State migrations — when the schema changes, bump `CURRENT_VERSION`
 * and add a migration to [`MIGRATIONS`]. Never edit a published
 * shape in place.
 */

import { PlatformStorage } from './platform';
import type { PendingOutgoingTx } from './pending-outgoing';

// ============================================================================
// Schema
// ============================================================================

/** Bump on every breaking schema change; add a migration. */
export const CURRENT_VERSION = 4;

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
   *   window-close on desktop). **Has security implications** — when
   *   > 0, the unlocked mnemonic is mirrored to the platform's
   *   ephemeral-keyed storage for the configured duration. `0`
   *   (default) = lock immediately at session end (the safe default).
   *   `-1` = never auto-lock until the user manually locks or the
   *   app fully exits.
   * - `theme`: id of the registered theme from `@smirk/ui/themes`.
   *   Unknown ids fall back to the default theme at apply time.
   */
  ui: {
    balanceHidden: boolean;
    denomination: string;
    autoLockMinutes: number;
    theme: string;
  };

  /**
   * In-flight outgoing sends. Each entry holds the txHash + amount +
   * fee returned from a successful broadcast/submit. Displayed
   * available balance subtracts these so the user gets immediate
   * feedback before the network scanner catches up. Entries age out
   * per-asset (see `./pending-outgoing`). Survives popup-close,
   * dies on browser-close — appropriate window for the use case.
   */
  pendingOutgoing: PendingOutgoingTx[];
}

export interface Route {
  /** Route id — `"home"`, `"home/asset/btc"`, `"swap"`, `"inbox/item/<id>"`, etc. */
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
  },
  pendingOutgoing: [],
};

/**
 * Per-version migration. Each entry takes the state at version N and
 * returns the state at version N+1. The sequence runs from the
 * stored `version` up to `CURRENT_VERSION`.
 *
 * Add new entries, never edit existing ones — once a version has
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
};

/** Apply migrations in order to bring `raw` up to `CURRENT_VERSION`. */
export function migrate(raw: unknown): SessionState {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SESSION_STATE };
  }
  let state = raw as { version?: number };

  // Unversioned legacy state — accept as v0 and let migrations fill in.
  let version = typeof state.version === 'number' ? state.version : 0;

  // Stored state is from a future version (downgrade scenario, or
  // multiple Smirk installs at different versions writing to the same
  // storage). Reset rather than try to forward-compat; ephemeral
  // state loss is safe — wallet seed lives elsewhere.
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

  // Final shape sanity — fill in defaults for any missing fields a
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
 * Typed reactive store for the session state. Wraps a [`PlatformStorage`]
 * backend with:
 *
 * - In-memory cache (avoids a round-trip per read)
 * - Atomic update via `update(fn)` (load-mutate-save)
 * - Subscriber notifications when other contexts (extension pop-out,
 *   second window, etc.) write to the same storage
 *
 * Framework-agnostic — exposes `subscribe(listener)` so any UI layer
 * can wire it up. The Preact hooks live in `@smirk/ui/state`.
 */
export class SessionStateStore {
  private cached: SessionState | null = null;
  private readonly listeners = new Set<(state: SessionState) => void>();
  private readonly platformUnsub: () => void;

  /**
   * Tracks the JSON of our last own write so the platform-subscribe
   * callback can skip the round-trip when the change came from us.
   * Avoids double-notification (one direct from `save`, one from
   * `storage.subscribe` re-firing on our own write).
   */
  private lastWrittenJson: string | null = null;

  constructor(
    private readonly storage: PlatformStorage,
    private readonly key: string = STORAGE_KEY,
  ) {
    // Listen for cross-context writes (e.g. extension pop-out window
    // updating state while the popup is open, or a Tauri second window).
    // Skip writes that originated here so we don't double-notify.
    this.platformUnsub = this.storage.subscribe((changedKey) => {
      if (changedKey !== this.key) return;
      void this.storage.get<unknown>(this.key).then((raw) => {
        const incomingJson = raw === null ? '' : JSON.stringify(raw);
        if (incomingJson === this.lastWrittenJson) {
          // Echo of our own write — skip.
          return;
        }
        const next = raw === null ? { ...DEFAULT_SESSION_STATE } : migrate(raw);
        this.cached = next;
        for (const l of this.listeners) l(next);
      });
    });
  }

  /** Read the current state. Loads from storage on first call; caches afterward. */
  async load(): Promise<SessionState> {
    if (this.cached) return this.cached;
    const raw = await this.storage.get<unknown>(this.key);
    this.cached = raw === null ? { ...DEFAULT_SESSION_STATE } : migrate(raw);
    return this.cached;
  }

  /** Replace the entire state. Most callers want [`update`] instead. */
  async save(state: SessionState): Promise<void> {
    this.cached = state;
    this.lastWrittenJson = JSON.stringify(state);
    await this.storage.set(this.key, state);
    for (const l of this.listeners) l(state);
  }

  /**
   * Atomically read-modify-write the state. The mutator may mutate
   * the passed object directly (it's a fresh copy) or return a new
   * shape; both are handled.
   */
  async update(
    mutator: (state: SessionState) => void | SessionState | Promise<void | SessionState>,
  ): Promise<SessionState> {
    const current = await this.load();
    const draft: SessionState = JSON.parse(JSON.stringify(current));
    const result = await mutator(draft);
    const next = (result === undefined ? draft : result) as SessionState;
    await this.save(next);
    return next;
  }

  /**
   * Reset to defaults. Useful for tests + a "clear local UI state"
   * settings option.
   */
  async reset(): Promise<SessionState> {
    return this.save({ ...DEFAULT_SESSION_STATE }).then(() => ({ ...DEFAULT_SESSION_STATE }));
  }

  /**
   * Subscribe to state changes — fires after every write (local or
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
