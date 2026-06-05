/**
 * `MockController` — a `DappBrowserController` implementation backed
 * by in-memory state and no actual webview.
 *
 * Use cases:
 *  - Component tests (Vitest, Storybook) that render `BrowserShell`
 *    without a real platform.
 *  - Headless development of UI features against scripted navigation
 *    sequences.
 *  - Integration tests of `@smirk/dapp-api` wallet handlers that
 *    don't care which platform fired the page request.
 *
 * The mock is deliberately minimal — it tracks the state shape the
 * interface promises and emits subscription events, but does not
 * simulate page loads, redirects, document title changes, etc. Tests
 * that need those should call the mock's explicit override hooks
 * (`mock.simulatePageLoad(...)`, `mock.simulateTitleChange(...)`)
 * rather than relying on inferred behaviour.
 */

import {
  type BrowserFrameRect,
  type BrowserNavigationState,
  type BrowserTab,
  type PageRequest,
  type PageRequestHandler,
  type TabId,
  makeTabId,
  NotSupportedError,
  UnknownTabError,
} from './types';
import type { BrowserSnapshot, DappBrowserController } from './controller';

/**
 * Configuration for the mock. All fields are optional.
 */
export interface MockControllerOptions {
  /**
   * URL to navigate to when a new tab is opened without one. Defaults
   * to `about:blank`.
   */
  readonly homeUrl?: string;
}

/**
 * `DappBrowserController` test double. See file header for usage.
 */
export class MockController implements DappBrowserController {
  private readonly homeUrl: string;
  private opened = false;
  private nextTabSerial = 1;
  private readonly tabs = new Map<TabId, BrowserTab>();
  private activeTabId: TabId | null = null;
  private readonly subscribers = new Set<(s: BrowserSnapshot) => void>();
  private pageRequestHandler: PageRequestHandler | null = null;
  private initScripts: readonly string[] = [];
  private currentRect: BrowserFrameRect | null = null;

  constructor(options: MockControllerOptions = {}) {
    this.homeUrl = options.homeUrl ?? 'about:blank';
  }

  // --------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------

  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    if (this.tabs.size === 0) {
      await this.newTab();
    }
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.tabs.clear();
    this.activeTabId = null;
    this.opened = false;
    // Surviving subscribers receive no final snapshot — the controller
    // is closed and there's nothing meaningful to emit.
  }

  // --------------------------------------------------------------------
  // Init scripts
  // --------------------------------------------------------------------

  async setInitScripts(scripts: readonly string[]): Promise<void> {
    this.initScripts = scripts;
  }

  /** Test helper: read what's been registered. */
  getInitScripts(): readonly string[] {
    return this.initScripts;
  }

  // --------------------------------------------------------------------
  // Tab management
  // --------------------------------------------------------------------

  async newTab(url?: string): Promise<TabId> {
    this.assertOpen('newTab');
    const id = makeTabId(`mock-tab-${this.nextTabSerial++}`);
    const targetUrl = url ?? this.homeUrl;
    const tab: BrowserTab = {
      id,
      createdAt: Date.now(),
      state: this.makeInitialState(targetUrl),
    };
    this.tabs.set(id, tab);
    this.activeTabId = id;
    this.emit();
    return id;
  }

  async closeTab(id: TabId): Promise<void> {
    this.assertOpen('closeTab');
    if (!this.tabs.has(id)) throw new UnknownTabError(id);
    this.tabs.delete(id);
    if (this.activeTabId === id) {
      const remaining = [...this.tabs.values()];
      this.activeTabId = remaining[remaining.length - 1]?.id ?? null;
    }
    if (this.tabs.size === 0) {
      // Per the interface docs, allocate a fresh tab so callers
      // always have somewhere to navigate. Matches Tauri impl.
      await this.newTab();
      return;
    }
    this.emit();
  }

  async switchTab(id: TabId): Promise<void> {
    this.assertOpen('switchTab');
    if (!this.tabs.has(id)) throw new UnknownTabError(id);
    this.activeTabId = id;
    this.emit();
  }

  async listTabs(): Promise<readonly BrowserTab[]> {
    return [...this.tabs.values()];
  }

  async activeTab(): Promise<TabId> {
    this.assertOpen('activeTab');
    if (this.activeTabId === null) {
      throw new NotSupportedError('activeTab', 'no tabs exist');
    }
    return this.activeTabId;
  }

  // --------------------------------------------------------------------
  // Per-tab navigation
  // --------------------------------------------------------------------

  async navigate(url: string, tab?: TabId): Promise<void> {
    this.assertOpen('navigate');
    const target = this.resolveTab(tab);
    this.updateState(target, (prev) => ({
      ...this.makeInitialState(url),
      // Preserve canGoBack — navigating from a non-empty tab makes
      // back-navigation possible.
      canGoBack: prev.url !== '' && prev.url !== this.homeUrl,
      canGoForward: false,
    }));
  }

  async goBack(tab?: TabId): Promise<void> {
    this.assertOpen('goBack');
    const target = this.resolveTab(tab);
    // The mock doesn't track full history — flip the boolean and
    // leave the URL alone. Tests that need real back-stack semantics
    // should drive the controller with explicit `navigate` calls.
    this.updateState(target, (prev) => ({
      ...prev,
      canGoBack: false,
      canGoForward: true,
    }));
  }

  async goForward(tab?: TabId): Promise<void> {
    this.assertOpen('goForward');
    const target = this.resolveTab(tab);
    this.updateState(target, (prev) => ({
      ...prev,
      canGoBack: true,
      canGoForward: false,
    }));
  }

  async reload(tab?: TabId): Promise<void> {
    this.assertOpen('reload');
    const target = this.resolveTab(tab);
    this.updateState(target, (prev) => ({ ...prev, isLoading: true }));
    // Simulate near-instant completion. Tests that need to assert
    // mid-load behaviour should drive `simulatePageLoad` directly.
    queueMicrotask(() =>
      this.updateState(target, (prev) => ({ ...prev, isLoading: false })),
    );
  }

  // --------------------------------------------------------------------
  // Frame positioning
  // --------------------------------------------------------------------

  async setFrameRect(rect: BrowserFrameRect): Promise<void> {
    this.currentRect = rect;
  }

  async hideFrame(): Promise<void> {
    this.currentRect = { x: 0, y: 0, width: 0, height: 0 };
  }

  /** Test helper: read the most recent rect the UI requested. */
  getFrameRect(): BrowserFrameRect | null {
    return this.currentRect;
  }

  // --------------------------------------------------------------------
  // Subscription
  // --------------------------------------------------------------------

  subscribe(listener: (snapshot: BrowserSnapshot) => void): () => void {
    this.subscribers.add(listener);
    // Emit immediately so consumers don't have to read state separately.
    if (this.activeTabId !== null) {
      listener(this.snapshot());
    }
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
   * Test helper: simulate a page-side wallet RPC and return the
   * wallet's response.
   */
  async simulatePageRequest(req: PageRequest): Promise<unknown> {
    if (!this.pageRequestHandler) {
      throw new NotSupportedError(
        'simulatePageRequest',
        'no handler registered',
      );
    }
    return this.pageRequestHandler(req);
  }

  /**
   * Test helper: drive a page-load completion for the active (or
   * specified) tab. Updates `title`, `isLoading`, `canGoBack`.
   */
  simulatePageLoad(
    title: string,
    options: { tab?: TabId; faviconUrl?: string } = {},
  ): void {
    const target = this.resolveTab(options.tab);
    this.updateState(target, (prev) => {
      // exactOptionalPropertyTypes: only attach `faviconUrl` when we
      // have a non-undefined value to write. Either the caller passed
      // one OR we inherit the prior value if any.
      const nextFavicon = options.faviconUrl ?? prev.faviconUrl;
      const base: BrowserNavigationState = {
        ...prev,
        title,
        isLoading: false,
      };
      return nextFavicon !== undefined
        ? { ...base, faviconUrl: nextFavicon }
        : base;
    });
  }

  // --------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------

  private assertOpen(operation: string): void {
    if (!this.opened) {
      throw new NotSupportedError(
        operation,
        'controller is closed — call open() first',
      );
    }
  }

  private resolveTab(maybeId?: TabId): TabId {
    if (maybeId !== undefined) {
      if (!this.tabs.has(maybeId)) throw new UnknownTabError(maybeId);
      return maybeId;
    }
    if (this.activeTabId === null) {
      throw new NotSupportedError('resolveTab', 'no active tab');
    }
    return this.activeTabId;
  }

  private updateState(
    id: TabId,
    transform: (prev: BrowserNavigationState) => BrowserNavigationState,
  ): void {
    const existing = this.tabs.get(id);
    if (!existing) throw new UnknownTabError(id);
    this.tabs.set(id, { ...existing, state: transform(existing.state) });
    this.emit();
  }

  private snapshot(): BrowserSnapshot {
    if (this.activeTabId === null) {
      throw new NotSupportedError('snapshot', 'no active tab');
    }
    const active = this.tabs.get(this.activeTabId);
    if (!active) {
      throw new NotSupportedError('snapshot', 'active tab missing from map');
    }
    return {
      activeTab: this.activeTabId,
      tabs: [...this.tabs.values()],
      activeState: active.state,
    };
  }

  private emit(): void {
    if (this.activeTabId === null) return;
    const snap = this.snapshot();
    for (const sub of this.subscribers) sub(snap);
  }

  private makeInitialState(url: string): BrowserNavigationState {
    let origin = '';
    try {
      const parsed = new URL(url).origin;
      // WHATWG opaque origins (e.g. `about:blank`, `data:`) serialize
      // to the literal string `'null'`. Treat those the same as
      // unparseable inputs — no origin to grant permissions against.
      if (parsed !== 'null') origin = parsed;
    } catch {
      // Non-URL inputs (e.g. search terms) leave origin empty.
    }
    const securityState: BrowserNavigationState['securityState'] =
      url.startsWith('https://') ? 'secure'
        : url.startsWith('http://') ? 'insecure'
          : 'unknown';
    return {
      url,
      title: '',
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
      origin,
      securityState,
    };
  }
}
