/**
 * Platform-storage abstraction.
 *
 * Different runtimes have different "ephemeral state" stores with
 * different lifetime semantics. The popup-state store sits on top of
 * this interface — pick the right backend at boot, the rest of
 * `@smirk/core/state/` doesn't care which platform it's on.
 *
 * | Platform               | Backend                          | Lifetime                          |
 * |------------------------|----------------------------------|-----------------------------------|
 * | Browser ext (popup)    | `chrome.storage.session`         | Survives popup close, dies on browser close |
 * | Browser ext (prefs)    | `chrome.storage.local`           | Survives browser close            |
 * | Capacitor (mobile)     | `@capacitor/preferences`         | Survives app close (until uninstall) |
 * | Tauri / web / tests    | `localStorage` / in-memory       | Survives unless explicitly cleared |
 *
 * The semantic difference between "session" (extension) and "preferences"
 * (mobile/desktop) is real — on iOS/Android, killing an app and
 * relaunching is the closest analog to "browser close," and platform
 * convention is that ephemeral UI state survives that gracefully.
 * Document the difference at the call site if it matters.
 */

/** Common storage interface every backend implements. */
export interface PlatformStorage {
  /** Read a typed value; returns `null` if the key doesn't exist. */
  get<T>(key: string): Promise<T | null>;

  /** Write a typed value. JSON-serializable types only. */
  set<T>(key: string, value: T): Promise<void>;

  /** Delete a key. No-op if it doesn't exist. */
  remove(key: string): Promise<void>;

  /**
   * Subscribe to cross-context changes. Fires when *another* document
   * (popup → pop-out, or two extension contexts) writes to the same
   * storage. Returns an unsubscribe function.
   *
   * Backends without cross-context change notification (in-memory,
   * naive localStorage) implement a no-op subscribe — the local
   * context will see its own writes via direct mutation, just not
   * remote-context writes.
   */
  subscribe(listener: (key: string) => void): () => void;
}

// ============================================================================
// In-memory backend — for tests + as a fallback
// ============================================================================

/**
 * In-memory storage. Survives nothing — useful for tests, fallback
 * when no other backend is available.
 */
export class InMemoryStorage implements PlatformStorage {
  private readonly map = new Map<string, unknown>();
  private readonly listeners = new Set<(key: string) => void>();

  async get<T>(key: string): Promise<T | null> {
    return (this.map.get(key) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
    for (const l of this.listeners) l(key);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
    for (const l of this.listeners) l(key);
  }

  subscribe(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

// ============================================================================
// Chrome extension backends
// ============================================================================

/**
 * Type-narrow shim for the bits of `chrome.storage.*` we use, so this
 * module compiles in non-extension TS contexts without pulling
 * `@types/chrome` into `@smirk/core`'s dependencies.
 */
interface ChromeStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface ChromeStorageOnChanged {
  addListener(
    cb: (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: string,
    ) => void,
  ): void;
  removeListener(
    cb: (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: string,
    ) => void,
  ): void;
}

interface ChromeStorageGlobal {
  storage?: {
    session?: ChromeStorageArea;
    local?: ChromeStorageArea;
    onChanged?: ChromeStorageOnChanged;
  };
}

/**
 * Backend backed by `chrome.storage.session` — survives popup close,
 * dies on browser close. Right tier for ephemeral UI state (current
 * route, mid-wizard form values, scroll position).
 */
export class ChromeSessionStorage implements PlatformStorage {
  private readonly area: ChromeStorageArea;
  private readonly onChanged: ChromeStorageOnChanged;
  private readonly areaName = 'session';

  constructor(chromeApi: ChromeStorageGlobal = (globalThis as { chrome?: ChromeStorageGlobal }).chrome ?? {}) {
    if (!chromeApi.storage?.session || !chromeApi.storage.onChanged) {
      throw new Error(
        'ChromeSessionStorage: chrome.storage.session is unavailable. ' +
          'Are you running in a browser-extension context with the "storage" permission?',
      );
    }
    this.area = chromeApi.storage.session;
    this.onChanged = chromeApi.storage.onChanged;
  }

  async get<T>(key: string): Promise<T | null> {
    const result = await this.area.get(key);
    return (result[key] as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.area.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await this.area.remove(key);
  }

  subscribe(listener: (key: string) => void): () => void {
    const handler = (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== this.areaName) return;
      for (const key of Object.keys(changes)) {
        listener(key);
      }
    };
    this.onChanged.addListener(handler);
    return () => {
      this.onChanged.removeListener(handler);
    };
  }
}

/**
 * Backend backed by `chrome.storage.local` — survives browser close.
 * Right tier for user preferences (denomination, theme, spam mode,
 * RPC-server overrides). Don't use for sensitive state (seed lives
 * elsewhere, encrypted).
 */
export class ChromeLocalStorage implements PlatformStorage {
  private readonly area: ChromeStorageArea;
  private readonly onChanged: ChromeStorageOnChanged;
  private readonly areaName = 'local';

  constructor(chromeApi: ChromeStorageGlobal = (globalThis as { chrome?: ChromeStorageGlobal }).chrome ?? {}) {
    if (!chromeApi.storage?.local || !chromeApi.storage.onChanged) {
      throw new Error(
        'ChromeLocalStorage: chrome.storage.local is unavailable. ' +
          'Are you running in a browser-extension context with the "storage" permission?',
      );
    }
    this.area = chromeApi.storage.local;
    this.onChanged = chromeApi.storage.onChanged;
  }

  async get<T>(key: string): Promise<T | null> {
    const result = await this.area.get(key);
    return (result[key] as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.area.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await this.area.remove(key);
  }

  subscribe(listener: (key: string) => void): () => void {
    const handler = (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== this.areaName) return;
      for (const key of Object.keys(changes)) {
        listener(key);
      }
    };
    this.onChanged.addListener(handler);
    return () => {
      this.onChanged.removeListener(handler);
    };
  }
}

// ============================================================================
// Web localStorage backend
// ============================================================================

/**
 * Backend backed by `localStorage`. Useful for Tauri (uses webview
 * localStorage), web testbeds, and as a fallback when chrome.storage
 * isn't available.
 *
 * Cross-context notification works via the `storage` event — fires in
 * other tabs/windows of the same origin when localStorage changes.
 * (Doesn't fire in the same tab that wrote the value, which is fine
 * for our subscribe-to-remote-changes use case.)
 */
export class WebLocalStorage implements PlatformStorage {
  constructor(private readonly storage: Storage = globalThis.localStorage) {
    if (!storage) {
      throw new Error('WebLocalStorage: localStorage is unavailable in this context.');
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = this.storage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.storage.setItem(key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    this.storage.removeItem(key);
  }

  subscribe(listener: (key: string) => void): () => void {
    const handler = (e: StorageEvent) => {
      if (e.key !== null) listener(e.key);
    };
    if (typeof addEventListener === 'function') {
      addEventListener('storage', handler);
      return () => removeEventListener('storage', handler);
    }
    return () => {};
  }
}

// ============================================================================
// Auto-detect helper
// ============================================================================

/**
 * Pick the most appropriate ephemeral-state backend for the current
 * runtime. Prefers `chrome.storage.session` if available; falls back
 * to `localStorage`; falls back to in-memory.
 *
 * Capacitor (mobile) callers should construct the appropriate backend
 * directly from `@capacitor/preferences` — that's a future
 * `CapacitorPreferencesStorage` once mobile lands.
 */
export function autoDetectEphemeralStorage(): PlatformStorage {
  const g = globalThis as { chrome?: ChromeStorageGlobal };
  if (g.chrome?.storage?.session && g.chrome.storage.onChanged) {
    return new ChromeSessionStorage(g.chrome);
  }
  if (typeof globalThis.localStorage !== 'undefined') {
    return new WebLocalStorage();
  }
  return new InMemoryStorage();
}
