/**
 * Pure data types for the embedded-browser surface.
 *
 * Types in this file are platform-agnostic and dependency-free. They
 * are the contract between `DappBrowserController` implementations and
 * the UI components that consume them. Adding a field here implies
 * teaching every implementation about it, so prefer additive,
 * optional fields where possible.
 *
 * For the broader architecture see [docs/EMBEDDED_BROWSER.md](../../../docs/EMBEDDED_BROWSER.md).
 */

// ======================================================================
// Branded identifiers
// ======================================================================

/**
 * Opaque tab identifier. Branded so callers cannot mix a `TabId` with
 * an arbitrary string (e.g. a URL or a session id).
 *
 * Construct via `makeTabId(string)`. Controllers generate ids however
 * they like — typically UUID v4 — but consumers should treat the
 * value as fully opaque.
 */
export type TabId = string & { readonly __tag: 'TabId' };

/**
 * Construct a `TabId` from a raw string. The function is a type-level
 * cast; runtime validation is the controller's responsibility.
 */
export function makeTabId(raw: string): TabId {
  return raw as TabId;
}

// ======================================================================
// Navigation state
// ======================================================================

/**
 * The current navigation snapshot for a tab. Equivalent to a row in
 * the browser's URL bar plus the bits the chrome needs to render
 * (loading state, history navigability, favicon).
 *
 * State is *observed*, not commanded — to change the URL you call
 * `controller.navigate(url)`, then receive the new state via
 * `controller.subscribe`.
 */
export interface BrowserNavigationState {
  /** Current URL as displayed by the webview. */
  readonly url: string;

  /**
   * Document title from the embedded page. Empty until the page sets
   * one (most do via `<title>`); fall back to displaying `url` when
   * empty.
   */
  readonly title: string;

  /**
   * True while the webview reports a navigation in progress. Equivalent
   * to the browser's reload-button-becomes-stop indicator.
   */
  readonly isLoading: boolean;

  /** Whether `controller.goBack()` would do anything. */
  readonly canGoBack: boolean;

  /** Whether `controller.goForward()` would do anything. */
  readonly canGoForward: boolean;

  /**
   * Favicon URL the embedded page advertised, when known. Absolute
   * URL. UI should fall back to a generic globe icon when undefined.
   */
  readonly faviconUrl?: string;

  /**
   * Origin of the current document, derived from `url`. Pre-computed
   * here because consumers (CSP indicators, permission badges) need
   * it on every render and parsing on the hot path is wasteful.
   */
  readonly origin: string;

  /**
   * Coarse security indicator. `'secure'` for HTTPS without mixed
   * content; `'insecure'` for plain HTTP; `'mixed'` for HTTPS with
   * non-secure subresources; `'unknown'` while loading or for
   * non-network schemes (e.g. `about:`).
   */
  readonly securityState: 'secure' | 'insecure' | 'mixed' | 'unknown';
}

// ======================================================================
// Tabs
// ======================================================================

/**
 * A single browser tab. Tabs are the unit of webview ownership — each
 * tab corresponds to exactly one native webview instance under the
 * hood.
 *
 * Note that `state` is a snapshot. Subscribe to the controller for
 * live updates.
 */
export interface BrowserTab {
  readonly id: TabId;
  readonly state: BrowserNavigationState;
  /** Unix ms when the tab was created. Used for tab-strip sort order. */
  readonly createdAt: number;
}

// ======================================================================
// Frame positioning
// ======================================================================

/**
 * Position + size for the embedded webview relative to the host
 * window. Coordinates are CSS pixels in the host window's coordinate
 * system (top-left origin).
 *
 * Why this shape: native webviews on every platform we target
 * (Tauri's `WebviewWindow`, iOS `WKWebView`, Android `WebView`,
 * WebKitGTK) accept a rectangle in window-relative coordinates. The
 * UI layer measures the slot it allocates for the browser frame and
 * calls `controller.setFrameRect` whenever it changes.
 */
export interface BrowserFrameRect {
  /** Horizontal offset from the host window's left edge, in CSS px. */
  readonly x: number;
  /** Vertical offset from the host window's top edge, in CSS px. */
  readonly y: number;
  /** Width in CSS px. */
  readonly width: number;
  /** Height in CSS px. */
  readonly height: number;
}

// ======================================================================
// Wallet RPC bridge
// ======================================================================

/**
 * Wire-format message from an embedded page, paired with the origin
 * the controller resolved it from. Opaque to this package — the
 * `request` field is whatever shape `@such-software/smirk-dapp-api`'s wallet
 * handler expects.
 *
 * Why `request: unknown` instead of importing the type: keeps
 * `@smirk/dapp-browser` zero-dependency. The composition layer in
 * the wallet shell narrows the type at the boundary.
 */
export interface PageRequest {
  readonly origin: string;
  readonly tab: TabId;
  readonly request: unknown;
}

/**
 * Handler signature for forwarding page wallet RPC into the wallet.
 * Returns a response that the controller routes back to the page.
 */
export type PageRequestHandler = (req: PageRequest) => Promise<unknown>;

// ======================================================================
// Errors
// ======================================================================

/**
 * Throw when a controller method is called against a controller that
 * doesn't implement that operation (e.g. `newTab()` on a future
 * single-tab impl that decides to reject extras instead of returning
 * the existing tab).
 */
export class NotSupportedError extends Error {
  override name = 'NotSupportedError';
  constructor(operation: string, details?: string) {
    super(
      details
        ? `Operation not supported: ${operation} (${details})`
        : `Operation not supported: ${operation}`,
    );
  }
}

/**
 * Throw when a tab id passed by a caller does not correspond to a
 * known tab. The browser controller is responsible for surfacing
 * this; the UI layer should treat it as an internal error and
 * recover (e.g. switch to the active tab).
 */
export class UnknownTabError extends Error {
  override name = 'UnknownTabError';
  constructor(tabId: string) {
    super(`Unknown tab id: ${tabId}`);
  }
}
