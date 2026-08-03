/**
 * `chrome.*` compatibility shim for the Tauri webview.
 *
 * The Smirk wallet popup is built against the Chrome MV3 extension
 * API surface: `chrome.storage.local`, `chrome.storage.session`,
 * `chrome.runtime.getURL`, etc. Rather than fork the popup code
 * into a Tauri-specific variant, we polyfill the narrow surface the
 * popup actually uses with Tauri-native equivalents:
 *
 * | chrome API                | Tauri implementation                           |
 * |---------------------------|------------------------------------------------|
 * | `chrome.storage.local`    | `@tauri-apps/plugin-store` (filesystem)        |
 * | `chrome.storage.session`  | In-memory `Map` (cleared on window close)      |
 * | `chrome.storage.onChanged`| Custom EventTarget around the two backends     |
 * | `chrome.runtime.getURL`   | Identity transform: Tauri serves from /       |
 * | `chrome.windows.create`   | No-op stub: there's no "popped out" in Tauri |
 *
 * Install order matters: this module's side-effects MUST run before
 * any popup code (which calls `chrome.*` at module top-level). See
 * `main.ts` for the hand-off.
 *
 * Limitations (v0.3.0):
 *  - `chrome.runtime.sendMessage` (the extension's background-SW
 *    bridge) is not polyfilled. The embedded browser handles dapp
 *    integration on desktop via its own Tauri-side bridge (see
 *    `browser_plugin.rs::attach_per_webview_rpc`), so the SW
 *    surface isn't needed.
 *  - `chrome.alarms` is NOT polyfilled. Auto-lock currently works
 *    only while the wallet window stays open (the popup-level timer
 *    fires); background auto-lock does not exist on desktop. Mobile
 *    will have the same gap until a `WalletTimers` abstraction lands
 *    (`packages/core/src/state/platform.ts`).
 *  - `chrome.notifications` is NOT polyfilled. Tip-arrival and
 *    confirmation notifications silently do nothing on desktop.
 *    Same `WalletNotifications` abstraction track.
 *  - `chrome.windows.create` is a no-op. The action-popup "pop out"
 *    button does nothing in desktop (single-window app).
 */

import { load, Store } from '@tauri-apps/plugin-store';

const STORE_FILENAME = 'smirk-storage.json';

let storeLoadPromise: Promise<Store> | null = null;
async function getStore(): Promise<Store> {
  if (!storeLoadPromise) {
    // `defaults: {}` satisfies the plugin's StoreOptions; we use the
    // empty object because every key the wallet writes is shaped by
    // the popup, not pre-seeded.
    storeLoadPromise = load(STORE_FILENAME, { autoSave: true, defaults: {} });
  }
  return storeLoadPromise;
}

// ============================================================================
// In-memory session storage. Cleared on window close, same lifecycle as
// chrome.storage.session in MV3 (popup close survives, browser close clears).
// ============================================================================

const sessionMap = new Map<string, unknown>();

// ============================================================================
// Cross-backend change-event bus. Mirrors chrome.storage.onChanged.
// ============================================================================

type ChromeStorageChange = { oldValue?: unknown; newValue?: unknown };
type ChromeOnChangedListener = (
  changes: Record<string, ChromeStorageChange>,
  areaName: 'local' | 'session' | 'sync' | 'managed',
) => void;

const onChangedListeners = new Set<ChromeOnChangedListener>();

function emitChange(
  area: 'local' | 'session',
  changes: Record<string, ChromeStorageChange>,
): void {
  for (const listener of onChangedListeners) {
    try {
      listener(changes, area);
    } catch (e) {
      console.warn('[chrome-shim] onChanged listener threw:', e);
    }
  }
}

// ============================================================================
// chrome.storage.local: backed by Tauri's filesystem store.
// ============================================================================

const localApi = {
  async get<T extends string | string[] | Record<string, unknown> | null | undefined>(
    keys?: T,
  ): Promise<Record<string, unknown>> {
    const store = await getStore();
    const out: Record<string, unknown> = {};
    if (keys === null || keys === undefined) {
      // Return everything.
      const entries = await store.entries();
      for (const [k, v] of entries) out[k] = v;
      return out;
    }
    if (typeof keys === 'string') {
      const v = await store.get(keys);
      if (v !== undefined && v !== null) out[keys] = v;
      return out;
    }
    if (Array.isArray(keys)) {
      for (const k of keys) {
        const v = await store.get(k);
        if (v !== undefined && v !== null) out[k] = v;
      }
      return out;
    }
    // Object form: default values per key. chrome returns the stored
    // value if present, otherwise the default.
    for (const k of Object.keys(keys)) {
      const v = await store.get(k);
      out[k] = v !== undefined && v !== null ? v : (keys as Record<string, unknown>)[k];
    }
    return out;
  },

  async set(items: Record<string, unknown>): Promise<void> {
    const store = await getStore();
    const changes: Record<string, ChromeStorageChange> = {};
    for (const [k, v] of Object.entries(items)) {
      const oldValue = await store.get(k);
      await store.set(k, v);
      changes[k] = { oldValue: oldValue ?? undefined, newValue: v };
    }
    emitChange('local', changes);
  },

  async remove(keys: string | string[]): Promise<void> {
    const store = await getStore();
    const keyArr = Array.isArray(keys) ? keys : [keys];
    const changes: Record<string, ChromeStorageChange> = {};
    for (const k of keyArr) {
      const oldValue = await store.get(k);
      await store.delete(k);
      changes[k] = { oldValue: oldValue ?? undefined };
    }
    emitChange('local', changes);
  },
};

// ============================================================================
// chrome.storage.session: backed by in-memory Map.
// ============================================================================

const sessionApi = {
  async get<T extends string | string[] | Record<string, unknown> | null | undefined>(
    keys?: T,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (keys === null || keys === undefined) {
      for (const [k, v] of sessionMap.entries()) out[k] = v;
      return out;
    }
    if (typeof keys === 'string') {
      if (sessionMap.has(keys)) out[keys] = sessionMap.get(keys);
      return out;
    }
    if (Array.isArray(keys)) {
      for (const k of keys) {
        if (sessionMap.has(k)) out[k] = sessionMap.get(k);
      }
      return out;
    }
    for (const k of Object.keys(keys)) {
      out[k] = sessionMap.has(k)
        ? sessionMap.get(k)
        : (keys as Record<string, unknown>)[k];
    }
    return out;
  },

  async set(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, ChromeStorageChange> = {};
    for (const [k, v] of Object.entries(items)) {
      const oldValue = sessionMap.get(k);
      sessionMap.set(k, v);
      changes[k] = { oldValue, newValue: v };
    }
    emitChange('session', changes);
  },

  async remove(keys: string | string[]): Promise<void> {
    const keyArr = Array.isArray(keys) ? keys : [keys];
    const changes: Record<string, ChromeStorageChange> = {};
    for (const k of keyArr) {
      const oldValue = sessionMap.get(k);
      sessionMap.delete(k);
      changes[k] = { oldValue };
    }
    emitChange('session', changes);
  },
};

// ============================================================================
// Install on the global. Must run before the popup module loads.
// ============================================================================

export function installChromeShim(): void {
  if ((globalThis as { chrome?: unknown }).chrome !== undefined) {
    // Already installed (HMR re-run or test environment). Leave it.
    return;
  }

  const chromeShim = {
    runtime: {
      getURL(path: string): string {
        // In Tauri, frontendDist serves from `/`; pass paths through
        // verbatim. Strip a leading slash if present so callers using
        // either `icons/x.svg` or `/icons/x.svg` resolve identically.
        const clean = path.startsWith('/') ? path.slice(1) : path;
        return `/${clean}`;
      },
      id: 'smirk-desktop',
    },
    storage: {
      local: localApi,
      session: sessionApi,
      onChanged: {
        addListener(listener: ChromeOnChangedListener) {
          onChangedListeners.add(listener);
        },
        removeListener(listener: ChromeOnChangedListener) {
          onChangedListeners.delete(listener);
        },
      },
    },
    windows: {
      async create(_options: unknown): Promise<void> {
        // Desktop is a single first-class window: the wallet IS the
        // popped-out experience. The action-popup "pop out" button
        // is a no-op here; no log because this fires every time the
        // user clicks it and the existing window stays focused.
      },
    },
  };

  (globalThis as { chrome?: unknown }).chrome = chromeShim;
}
