/**
 * `DappBrowserController` — the platform-implementation seam for
 * embedded-browser support across desktop (Tauri) and mobile
 * (Capacitor / iOS / Android).
 *
 * The interface here is the *entire* contract a platform must
 * implement to plug into Smirk's embedded browser. UI components
 * (`@smirk/ui/components/browser`) consume this interface, never any
 * specific implementation. Tests use the `MockController` from this
 * package; production wallets use the Tauri or Capacitor impls.
 *
 * For the architectural rationale see
 * [docs/EMBEDDED_BROWSER.md](../../../docs/EMBEDDED_BROWSER.md).
 *
 * Implementation notes for new controllers:
 *
 *  - Every method that takes an optional `tab?: TabId` parameter
 *    defaults to the currently-active tab when omitted. The active
 *    tab is the last one passed to `switchTab` (or the only tab if
 *    `newTab` has only ever been called once).
 *  - `subscribe` is the only reactive interface. Controllers MUST
 *    emit on every navigation state change of every tab AND on tab
 *    list / active-tab changes — UIs cannot derive state from
 *    one-shot reads alone.
 *  - Lifecycle: `open()` is idempotent. `close()` destroys all tabs
 *    and frees the underlying webview resources. Calling any other
 *    method between `close()` and the next `open()` is an error
 *    (throws `NotSupportedError`).
 */

import type {
  BrowserFrameRect,
  BrowserNavigationState,
  BrowserTab,
  PageRequestHandler,
  TabId,
} from './types';

/**
 * Snapshot consumed by subscribers. Includes the active tab id, the
 * full tab list, and the navigation state of the active tab pre-
 * extracted for convenience (subscribers almost always want this).
 */
export interface BrowserSnapshot {
  readonly activeTab: TabId;
  readonly tabs: readonly BrowserTab[];
  readonly activeState: BrowserNavigationState;
}

/**
 * The contract every embedded-browser implementation satisfies. See
 * the file header for usage patterns and lifecycle invariants.
 */
export interface DappBrowserController {
  // --------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------

  /**
   * Allocate the underlying webview resource and (if no tabs exist
   * yet) open one tab to a default URL. Idempotent — calling on an
   * already-open controller is a no-op.
   *
   * Returns once the webview is ready to receive `navigate` etc.
   */
  open(): Promise<void>;

  /**
   * Tear down the controller. Destroys every tab and frees the
   * underlying webview. After `close()`, the controller is unusable
   * until `open()` is called again.
   */
  close(): Promise<void>;

  // --------------------------------------------------------------------
  // Init scripts
  // --------------------------------------------------------------------

  /**
   * Set the script sources injected into every new tab at
   * document-start. Use this to install `window.smirk` (the page-side
   * `@smirk/dapp-api` surface) before the page's own scripts run.
   *
   * MUST be called before `open()` for the scripts to apply to the
   * initial tab. Updates after `open()` apply only to tabs created
   * subsequently — existing tabs are not reloaded.
   *
   * Why an array: multiple init scripts compose cleanly (e.g. the
   * wallet API plus an instrumentation hook). Order is preserved.
   */
  setInitScripts(scripts: readonly string[]): Promise<void>;

  // --------------------------------------------------------------------
  // Tab management
  // --------------------------------------------------------------------

  /**
   * Create a new tab and switch to it. If `url` is omitted, navigates
   * to the controller's default home page (impl-defined; typically
   * `about:blank` or a configured start page).
   *
   * Returns the new tab's id.
   */
  newTab(url?: string): Promise<TabId>;

  /**
   * Close a tab. If the closed tab was active, the controller picks
   * a replacement active tab (typically the most-recently-used). If
   * the last tab is closed, the controller MAY allocate a fresh
   * `about:blank` tab or MAY enter a no-tab state — check the impl's
   * docs.
   */
  closeTab(id: TabId): Promise<void>;

  /**
   * Switch the active tab. The previously-active tab continues to
   * exist (in the background) and retains its state.
   */
  switchTab(id: TabId): Promise<void>;

  /** Current tab list in creation order. */
  listTabs(): Promise<readonly BrowserTab[]>;

  /** Active tab's id. */
  activeTab(): Promise<TabId>;

  // --------------------------------------------------------------------
  // Per-tab navigation
  // --------------------------------------------------------------------

  /**
   * Navigate the given tab (or the active tab if omitted) to `url`.
   * Resolves once the navigation has *committed* (the controller has
   * told the webview to load the URL) — does NOT wait for the page
   * to finish loading. Watch the subscription stream for the
   * `isLoading: false` transition if you need load-complete.
   *
   * Implementations should treat scheme-less inputs as `https://`
   * (typical browser URL-bar behaviour). Inputs that look like
   * search terms rather than URLs MAY be routed through a configured
   * search provider, but the default is to attempt as a URL.
   */
  navigate(url: string, tab?: TabId): Promise<void>;

  /**
   * Go back one entry in the tab's session history. No-op if
   * `canGoBack` is false.
   */
  goBack(tab?: TabId): Promise<void>;

  /**
   * Go forward one entry in the tab's session history. No-op if
   * `canGoForward` is false.
   */
  goForward(tab?: TabId): Promise<void>;

  /**
   * Reload the current page. Equivalent to the user hitting reload —
   * does NOT bypass the HTTP cache (use `reload({ hard: true })`
   * once that overload is added, post-MVP, for cache-bypass).
   */
  reload(tab?: TabId): Promise<void>;

  // --------------------------------------------------------------------
  // Frame positioning
  // --------------------------------------------------------------------

  /**
   * Position the active tab's webview at the given rect, in CSS px
   * relative to the host window. Called by `BrowserShell` on layout
   * change.
   *
   * Implementations typically debounce / coalesce rapid calls (e.g.
   * during a window resize) — repeated identical rects MUST be safe
   * to send.
   */
  setFrameRect(rect: BrowserFrameRect): Promise<void>;

  /**
   * Hide the webview (without destroying the tab) so the chrome can
   * present a different surface (e.g. a settings overlay). Equivalent
   * to `setFrameRect({0, 0, 0, 0})` but expressed semantically.
   */
  hideFrame(): Promise<void>;

  // --------------------------------------------------------------------
  // Subscription
  // --------------------------------------------------------------------

  /**
   * Subscribe to all state changes — tab list, active tab, per-tab
   * navigation state. Listener is called immediately with the current
   * snapshot, then on every subsequent change.
   *
   * Returns an unsubscribe function. Idempotent; calling twice is a
   * no-op.
   */
  subscribe(listener: (snapshot: BrowserSnapshot) => void): () => void;

  // --------------------------------------------------------------------
  // Wallet RPC bridge
  // --------------------------------------------------------------------

  /**
   * Install the wallet RPC handler. Every wire-format message that
   * arrives from an embedded page is routed through this handler;
   * the returned response is forwarded back to the originating tab.
   *
   * Replacing the handler replaces all routing. Pass `null` to
   * disconnect (wallet RPC requests will then reject in the page).
   */
  setPageRequestHandler(handler: PageRequestHandler | null): void;
}
