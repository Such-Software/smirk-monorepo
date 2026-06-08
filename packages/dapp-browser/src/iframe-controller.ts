/**
 * `IframeBrowserController` — a `DappBrowserController` implementation
 * backed by `<iframe>` elements rendered inside the wallet's main
 * webview, communicating with the page via `postMessage`.
 *
 * Used where the native-WebView-per-tab pattern is unreliable —
 * notably Linux desktop, where WebKitGTK's accelerated compositor
 * loses its backing surface on parent-window resize and renders
 * subsequent frames as solid black (upstream tauri-apps/tauri#7537,
 * tauri-apps/wry#1727 family). The iframe path sidesteps the failure
 * mode entirely: there is no separate native window, no separate GL
 * context, no race. Resize, reload, focus, and z-ordering all become
 * standard DOM operations.
 *
 * The controller is intentionally **DOM-free** — every iframe element
 * lives in the React/Preact tree and is owned by the
 * `IframeBrowserContent` component. The controller holds the tab
 * state, the navigation history per tab, and the page-request
 * handler reference; the component subscribes to the controller for
 * tab and active-tab state, renders one iframe per tab (with
 * `display: none` for inactive), and routes `postMessage` events
 * back through `dispatchPageMessage`.
 *
 * Same-origin assumption: `goBack` / `goForward` / `reload` cannot
 * touch `iframe.contentWindow.history` for cross-origin pages, so
 * we track navigation history in this controller and re-set the
 * iframe's `src` to navigate. This is functionally equivalent to a
 * browser back/forward for the user, with the trade-off that the
 * underlying page sees a fresh load instead of a `popstate` event.
 *
 * Page-script injection: cross-origin iframes don't allow parent-
 * side script injection (browser same-origin policy). The page is
 * expected to install `window.smirk` itself — typically via
 * `import { installSmirkPageApi } from '@such-software/smirk-dapp-api/page'` or
 * by including the standalone IIFE build as a `<script>`. The
 * `setInitScripts` method here is therefore a no-op, present only
 * to satisfy the interface contract. See
 * [docs/DAPP_INTEGRATION.md](../../../docs/DAPP_INTEGRATION.md) for
 * the dapp-side setup.
 */

import {
  type BrowserFrameRect,
  type BrowserNavigationState,
  type BrowserTab,
  type PageRequestHandler,
  type TabId,
  makeTabId,
  NotSupportedError,
  UnknownTabError,
} from './types';
import type { BrowserSnapshot, DappBrowserController } from './controller';

/**
 * Configuration for `IframeBrowserController`.
 */
export interface IframeControllerOptions {
  /** URL to open in the first tab when no explicit URL is supplied
   *  to `newTab()`. Defaults to `about:blank`. */
  readonly homeUrl?: string;
}

interface TabRecord {
  readonly id: TabId;
  readonly createdAt: number;
  /** Linear navigation history; `historyIndex` points at the entry
   *  the iframe currently displays. */
  history: string[];
  historyIndex: number;
  state: BrowserNavigationState;
  /** Monotonically-incremented counter the `IframeBrowserContent`
   *  uses as part of the iframe element's React key. Bumped by
   *  `reload()` to force a fresh document load even though the URL
   *  is unchanged (setting `src` to the same value is a no-op in
   *  most browsers). */
  reloadGen: number;
}

function deriveOrigin(url: string): string {
  if (url === 'about:blank' || url === '') return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function deriveSecurityState(url: string): BrowserNavigationState['securityState'] {
  if (url.startsWith('https://')) return 'secure';
  if (url.startsWith('http://')) return 'insecure';
  return 'unknown';
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return 'about:blank';
  if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function newNavigationState(url: string): BrowserNavigationState {
  return {
    url,
    title: '',
    isLoading: url !== 'about:blank',
    canGoBack: false,
    canGoForward: false,
    origin: deriveOrigin(url),
    securityState: deriveSecurityState(url),
  };
}

/**
 * Brand a controller as "inline-rendered" — consumers can detect
 * this to choose whether to mount the iframe content component
 * inside the BrowserShell's frame slot.
 */
export interface InlineModeController {
  readonly inlineMode: true;
}

export class IframeBrowserController
  implements DappBrowserController, InlineModeController
{
  readonly inlineMode = true as const;
  private readonly homeUrl: string;
  private opened = false;
  private nextTabSerial = 1;
  private readonly tabs = new Map<TabId, TabRecord>();
  private activeTabId: TabId | null = null;
  private readonly subscribers = new Set<(s: BrowserSnapshot) => void>();
  private pageRequestHandler: PageRequestHandler | null = null;
  /** Created-at counter so `listTabs` returns creation order. */
  private readonly createdAtCounter: () => number;

  constructor(options: IframeControllerOptions = {}) {
    this.homeUrl = options.homeUrl ?? 'about:blank';
    // Monotonic counter — avoids `Date.now()` in tests where time is
    // mocked, and keeps tab ordering deterministic across the run.
    let counter = 0;
    this.createdAtCounter = () => {
      counter += 1;
      return counter;
    };
  }

  // --------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------

  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    // Allocate a default tab on first open — matches the
    // `DappBrowserController` conformance contract ("opens with at
    // least one tab"). `newTab` would refuse if `opened` was still
    // false; we set it above first to keep that invariant.
    if (this.tabs.size === 0) {
      await this.newTabInternal(this.homeUrl);
    }
  }

  async close(): Promise<void> {
    this.tabs.clear();
    this.activeTabId = null;
    this.opened = false;
    this.notify();
  }

  // --------------------------------------------------------------------
  // Init scripts — no-op for iframe (see file header)
  // --------------------------------------------------------------------

  async setInitScripts(_scripts: readonly string[]): Promise<void> {
    // Cross-origin iframes block parent-side script injection. Pages
    // install `window.smirk` themselves via the dapp-api package.
  }

  // --------------------------------------------------------------------
  // Tab management
  // --------------------------------------------------------------------

  async newTab(url?: string): Promise<TabId> {
    this.assertOpen('newTab');
    return this.newTabInternal(url ?? this.homeUrl);
  }

  /** Internal tab-creation shared between `open()` and `newTab()`.
   *  Skips the `assertOpen` guard so `open()` can call it during
   *  the transition where `opened === true` but no tabs exist yet. */
  private async newTabInternal(url: string): Promise<TabId> {
    const target = normalizeUrl(url);
    const id = makeTabId(`iframe-tab-${this.nextTabSerial++}`);
    const record: TabRecord = {
      id,
      createdAt: this.createdAtCounter(),
      history: [target],
      historyIndex: 0,
      state: newNavigationState(target),
      reloadGen: 0,
    };
    this.tabs.set(id, record);
    this.activeTabId = id;
    this.notify();
    return id;
  }

  async closeTab(id: TabId): Promise<void> {
    this.assertOpen('closeTab');
    if (!this.tabs.has(id)) throw new UnknownTabError(id);
    this.tabs.delete(id);
    if (this.activeTabId === id) {
      // Pick the most-recently-created surviving tab.
      const remaining = [...this.tabs.values()];
      const fallback = remaining[remaining.length - 1];
      this.activeTabId = fallback ? fallback.id : null;
    }
    // If we just closed the last tab, allocate a replacement — the
    // controller is "open" so a tab list of zero would be an invalid
    // intermediate state per the conformance contract.
    if (this.tabs.size === 0) {
      await this.newTabInternal(this.homeUrl);
    } else {
      this.notify();
    }
  }

  async switchTab(id: TabId): Promise<void> {
    this.assertOpen('switchTab');
    if (!this.tabs.has(id)) throw new UnknownTabError(id);
    this.activeTabId = id;
    this.notify();
  }

  async listTabs(): Promise<readonly BrowserTab[]> {
    return [...this.tabs.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => ({ id: t.id, state: t.state, createdAt: t.createdAt }));
  }

  async activeTab(): Promise<TabId> {
    if (!this.activeTabId) {
      throw new NotSupportedError('activeTab', 'no active tab');
    }
    return this.activeTabId;
  }

  // --------------------------------------------------------------------
  // Per-tab navigation
  // --------------------------------------------------------------------

  async navigate(url: string, tab?: TabId): Promise<void> {
    this.assertOpen('navigate');
    const record = this.resolveTab(tab);
    if (!record) return;
    const target = normalizeUrl(url);
    // Truncate any "forward" history when the user navigates from a
    // back-stepped position — matches browser semantics.
    record.history = record.history.slice(0, record.historyIndex + 1);
    record.history.push(target);
    record.historyIndex = record.history.length - 1;
    record.state = this.recomputeState(record, target, true);
    this.notify();
  }

  async goBack(tab?: TabId): Promise<void> {
    this.assertOpen('goBack');
    const record = this.resolveTab(tab);
    if (!record) return;
    if (record.historyIndex <= 0) return;
    record.historyIndex -= 1;
    // Index is guaranteed in-range by the guard above + the
    // invariant maintained by `navigate`.
    const target = record.history[record.historyIndex] as string;
    record.state = this.recomputeState(record, target, true);
    this.notify();
  }

  async goForward(tab?: TabId): Promise<void> {
    this.assertOpen('goForward');
    const record = this.resolveTab(tab);
    if (!record) return;
    if (record.historyIndex >= record.history.length - 1) return;
    record.historyIndex += 1;
    const target = record.history[record.historyIndex] as string;
    record.state = this.recomputeState(record, target, true);
    this.notify();
  }

  async reload(tab?: TabId): Promise<void> {
    this.assertOpen('reload');
    const record = this.resolveTab(tab);
    if (!record) return;
    const target = record.history[record.historyIndex] as string;
    // Bump the per-tab reload generation. `IframeBrowserContent`
    // includes `reloadGen` in the iframe element's React key, so
    // React unmounts the old iframe and mounts a fresh one — which
    // is the only reliable cross-origin way to force a fresh
    // document load when the URL hasn't changed.
    record.reloadGen += 1;
    record.state = this.recomputeState(record, target, true);
    this.notify();
  }

  /**
   * Read the per-tab reload generation. Used by
   * `IframeBrowserContent` to key its iframe elements. Returns 0
   * for unknown tabs (defensive — the component can race with tab
   * close).
   */
  getReloadGen(tab: TabId): number {
    return this.tabs.get(tab)?.reloadGen ?? 0;
  }

  // --------------------------------------------------------------------
  // Frame positioning — no-ops for iframe (see file header)
  // --------------------------------------------------------------------

  async setFrameRect(_rect: BrowserFrameRect): Promise<void> {
    // CSS lays the iframe out inside its slot — no positioning needed.
  }

  async hideFrame(): Promise<void> {
    // Modals stack via z-index; the iframe doesn't need to be hidden
    // for an approval surface to render on top.
  }

  // --------------------------------------------------------------------
  // Subscription
  // --------------------------------------------------------------------

  subscribe(listener: (s: BrowserSnapshot) => void): () => void {
    this.subscribers.add(listener);
    const snap = this.currentSnapshot();
    if (snap) listener(snap);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  // --------------------------------------------------------------------
  // Wallet RPC bridge
  // --------------------------------------------------------------------

  setPageRequestHandler(handler: PageRequestHandler | null): void {
    this.pageRequestHandler = handler;
  }

  /**
   * Dispatch a postMessage from an embedded iframe to the wallet's
   * page-request handler. Called by `IframeBrowserContent` when it
   * receives a `message` event from one of the iframes it manages.
   *
   * Returns the handler's response (or `null` if no handler is set
   * or the handler resolves without a result). The caller posts that
   * response back into the iframe's window so the page-side
   * `@such-software/smirk-dapp-api` runtime resolves its waiting promise.
   */
  async dispatchPageMessage(
    origin: string,
    tab: TabId,
    payload: unknown,
  ): Promise<unknown> {
    const handler = this.pageRequestHandler;
    if (!handler) return null;
    return handler({ origin, tab, request: payload });
  }

  // --------------------------------------------------------------------
  // IframeBrowserContent integration — internal use only
  // --------------------------------------------------------------------

  /**
   * Notify the controller that an iframe finished a navigation cycle
   * (`load` event fired). Updates the tab's `isLoading: false` and
   * triggers a subscription emit so the URL bar's spinner stops.
   *
   * The component calls this for every iframe `load`; the controller
   * is the single source of truth for "is this tab loading?" so the
   * UI doesn't have to interleave per-iframe React state.
   */
  notifyTabLoaded(tab: TabId): void {
    const record = this.tabs.get(tab);
    if (!record) return;
    record.state = { ...record.state, isLoading: false };
    this.notify();
  }

  /**
   * Notify the controller of a title change reported from the page
   * via `document.title`. Pages can send this through the same
   * postMessage channel as wallet RPC by emitting a sentinel
   * envelope; the component routes those here.
   */
  notifyTabTitle(tab: TabId, title: string): void {
    const record = this.tabs.get(tab);
    if (!record) return;
    record.state = { ...record.state, title };
    this.notify();
  }

  // --------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------

  private assertOpen(op: string): void {
    if (!this.opened) {
      throw new NotSupportedError(op, 'controller is closed; call open() first');
    }
  }

  /** Resolve the target tab. Returns null when no resolvable tab
   *  exists, so callers can no-op gracefully (matches the
   *  conformance contract for `goBack` / `goForward` / `reload`
   *  on a freshly-opened controller). */
  private resolveTab(tab?: TabId): TabRecord | null {
    const id = tab ?? this.activeTabId;
    if (!id) return null;
    const record = this.tabs.get(id);
    if (!record) {
      if (tab !== undefined) throw new UnknownTabError(id);
      return null;
    }
    return record;
  }

  private recomputeState(
    record: TabRecord,
    url: string,
    isLoading: boolean,
  ): BrowserNavigationState {
    return {
      url,
      title: record.state.title,
      isLoading,
      canGoBack: record.historyIndex > 0,
      canGoForward: record.historyIndex < record.history.length - 1,
      origin: deriveOrigin(url),
      securityState: deriveSecurityState(url),
    };
  }

  private currentSnapshot(): BrowserSnapshot | null {
    if (!this.activeTabId) return null;
    const tabs = [...this.tabs.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => ({ id: t.id, state: t.state, createdAt: t.createdAt }));
    const active = this.tabs.get(this.activeTabId);
    if (!active) return null;
    return {
      activeTab: this.activeTabId,
      tabs,
      activeState: active.state,
    };
  }

  private notify(): void {
    const snap = this.currentSnapshot();
    if (!snap) return;
    for (const s of this.subscribers) {
      try {
        s(snap);
      } catch (e) {
        console.error('[IframeBrowserController] subscriber threw:', e);
      }
    }
  }
}
