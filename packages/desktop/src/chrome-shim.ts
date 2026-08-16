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
 *  - `chrome.runtime.sendMessage` resolves `undefined` instead of
 *    reaching a background worker, because desktop has none. Every
 *    current caller is a background *hint* (DM_WATCH_SET/CLEAR,
 *    DM_WRAPS_GET) whose foreground path still works, so dropping
 *    the hint degrades rather than breaks. It MUST exist as a
 *    function: `chrome.runtime` is defined here, so an unshimmed
 *    `.sendMessage(...)` is a synchronous TypeError that aborts the
 *    caller *before* any `.catch()` can attach -- which is how Lock
 *    and Forget-wallet silently died on desktop.
 *  - `chrome.runtime.connect` throws. The jobs coordinator lives in
 *    the background worker, so no port can be honoured; a stub port
 *    would hang every request forever instead. Throwing surfaces a
 *    real error to the bootstrap caller. Only reachable when the
 *    backend does not advertise `nostr_native_auth`.
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

// One debug line per dropped message type, not per call.
const warnedSendMessage = new Set<string>();

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
  // Do NOT bail merely because a `chrome` global exists. Windows runs on
  // WebView2, which is Chromium-based and already defines `window.chrome` for
  // its own host bridge (`chrome.webview`). A presence check therefore sees
  // WebView2's object, concludes the shim is installed, installs nothing, and
  // the popup dies at import time with "chrome.storage.local is unavailable".
  // macOS (WKWebView) and Linux (WebKitGTK) define no `chrome`, which is why
  // this only ever broke Windows.
  //
  // Test for OUR surface instead, and merge rather than replace: clobbering
  // `chrome.webview` would take Tauri's IPC channel with it.
  const existing = (globalThis as { chrome?: Record<string, unknown> }).chrome;
  const alreadyOurs =
    typeof existing?.['storage'] === 'object' &&
    (existing['storage'] as { local?: unknown } | undefined)?.local !== undefined;
  if (alreadyOurs) {
    // Genuine re-run (HMR, or a test that installed us once already).
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

      // Desktop has no background service worker. Callers use this to
      // hand the background a hint (start/stop DM polling, fetch wraps
      // it collected while away); there is nothing to hand it, so we
      // resolve `undefined` and let the foreground path carry the
      // feature. See the header note: the critical property is that
      // this is a *function*, so `chrome.runtime.sendMessage(...)`
      // returns a thenable rather than throwing synchronously.
      async sendMessage(message?: unknown): Promise<undefined> {
        const type =
          typeof message === 'object' && message !== null && 'type' in message
            ? String((message as { type: unknown }).type)
            : 'unknown';
        if (!warnedSendMessage.has(type)) {
          warnedSendMessage.add(type);
          console.debug(
            `[chrome-shim] chrome.runtime.sendMessage(${type}) dropped: desktop has no background worker`,
          );
        }
        return undefined;
      },

      // Deliberately throws rather than returning a dead port: the jobs
      // client resolves requests from port replies, so a stub port that
      // never answers would hang the caller forever. Fail loudly.
      connect(_info?: unknown): never {
        throw new Error(
          '[chrome-shim] chrome.runtime.connect is unavailable on desktop: ' +
            'the jobs coordinator runs in the extension background worker. ' +
            'Use a backend that advertises nostr_native_auth.',
        );
      },
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

  // Merge onto whatever the host already put there (WebView2's `chrome.webview`)
  // instead of assigning over it. Our keys win for the surface we implement; any
  // host-provided key we do not touch survives.
  (globalThis as { chrome?: unknown }).chrome = Object.assign(existing ?? {}, chromeShim);
}
