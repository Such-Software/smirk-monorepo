/**
 * `TauriBrowserController` — `DappBrowserController` implementation
 * backed by Tauri 2.x webview windows.
 *
 * Each tab corresponds to a separate `WebviewWindow` created in the
 * Tauri Rust plugin (see `src-tauri/src/browser_plugin.rs`). The
 * TypeScript side is a thin proxy: it invokes Rust commands and
 * subscribes to Tauri events that the plugin emits whenever any
 * tab's state changes.
 *
 * Lifecycle:
 *
 *  1. `setInitScripts` — caches the scripts on the JS side AND
 *     forwards them to Rust so the plugin can apply them when it
 *     creates new webview windows.
 *  2. `open` — invokes `smirk_browser_open`, which allocates the
 *     initial webview window and emits the first state snapshot.
 *  3. `newTab` / `closeTab` / `switchTab` — round-trip through Rust
 *     to manage webview window lifecycle.
 *  4. `navigate` / `goBack` / `goForward` / `reload` — round-trip
 *     through Rust to drive the webview's loader.
 *  5. `setFrameRect` — coalesced JS-side (we debounce rapid calls
 *     during resize) and pushed to Rust on the trailing edge.
 *  6. `setPageRequestHandler` — registers a listener for the Rust
 *     plugin's `smirk:browser:page-request` event. Responses go back
 *     via `smirk_browser_respond_page_request`.
 *
 * The Rust side is responsible for:
 *  - Allocating webview windows with appropriate webview options
 *    (init scripts, CSP, sandbox).
 *  - Capturing navigation state changes and emitting events.
 *  - Forwarding `window.smirk` wire messages from the embedded page
 *    to the wallet webview.
 *
 * This file is intentionally a thin proxy. Logic that could live in
 * either Rust or TS should live in Rust where it has direct access to
 * the webview APIs; TS just round-trips.
 *
 * STATUS: scaffold only. The Rust plugin currently stubs every
 * command — calling `controller.navigate` etc. will succeed but
 * won't actually drive a webview. Wiring the Rust commands to real
 * webview management is the next milestone (see `browser_plugin.rs`
 * file header for the implementation checklist).
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import {
  type BrowserFrameRect,
  type BrowserSnapshot,
  type DappBrowserController,
  type PageRequest,
  type PageRequestHandler,
  type TabId,
  NotSupportedError,
  makeTabId,
} from '@smirk/dapp-browser';

// ======================================================================
// Tauri command + event channel names
// ======================================================================
//
// Single source of truth for the Rust ↔ TS channel surface. Update
// both this file and `browser_plugin.rs` together when adding new
// commands or events.
//
// Naming convention: snake_case for commands (Tauri convention),
// colon-separated for events (Tauri ergonomic).
// ======================================================================

const CMD_OPEN = 'smirk_browser_open';
const CMD_CLOSE = 'smirk_browser_close';
const CMD_SET_INIT_SCRIPTS = 'smirk_browser_set_init_scripts';
const CMD_NEW_TAB = 'smirk_browser_new_tab';
const CMD_CLOSE_TAB = 'smirk_browser_close_tab';
const CMD_SWITCH_TAB = 'smirk_browser_switch_tab';
const CMD_NAVIGATE = 'smirk_browser_navigate';
const CMD_GO_BACK = 'smirk_browser_go_back';
const CMD_GO_FORWARD = 'smirk_browser_go_forward';
const CMD_RELOAD = 'smirk_browser_reload';
const CMD_SET_FRAME_RECT = 'smirk_browser_set_frame_rect';
const CMD_HIDE_FRAME = 'smirk_browser_hide_frame';
const CMD_RESPOND_PAGE_REQUEST = 'smirk_browser_respond_page_request';

const EVT_SNAPSHOT = 'smirk:browser:snapshot';
const EVT_PAGE_REQUEST = 'smirk:browser:page-request';

// The init-script transport name. Must match the value passed to
// `getPageApiInjectionScript({ transport: { kind: 'tauri', event } })`.
export const TAURI_DAPP_RPC_EVENT = 'smirk:dapp:rpc';

// ======================================================================
// Controller
// ======================================================================

/**
 * Tauri implementation of `DappBrowserController`. See file header
 * for architecture notes.
 */
export class TauriBrowserController implements DappBrowserController {
  private opened = false;
  private subscribers = new Set<(s: BrowserSnapshot) => void>();
  private pageRequestHandler: PageRequestHandler | null = null;
  private snapshotUnlisten: (() => void) | null = null;
  private pageRequestUnlisten: (() => void) | null = null;
  private latestSnapshot: BrowserSnapshot | null = null;
  private setRectTimer: number | null = null;
  private pendingRect: BrowserFrameRect | null = null;

  // --------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------

  async open(): Promise<void> {
    if (this.opened) return;
    await invoke(CMD_OPEN);
    this.opened = true;
    await this.attachListeners();
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.detachListeners();
    await invoke(CMD_CLOSE);
    this.opened = false;
    this.latestSnapshot = null;
  }

  // --------------------------------------------------------------------
  // Init scripts
  // --------------------------------------------------------------------

  async setInitScripts(scripts: readonly string[]): Promise<void> {
    await invoke(CMD_SET_INIT_SCRIPTS, { scripts });
  }

  // --------------------------------------------------------------------
  // Tab management
  // --------------------------------------------------------------------

  async newTab(url?: string): Promise<TabId> {
    this.assertOpen('newTab');
    const id = await invoke<string>(CMD_NEW_TAB, { url: url ?? null });
    return makeTabId(id);
  }

  async closeTab(id: TabId): Promise<void> {
    this.assertOpen('closeTab');
    await invoke(CMD_CLOSE_TAB, { id });
  }

  async switchTab(id: TabId): Promise<void> {
    this.assertOpen('switchTab');
    await invoke(CMD_SWITCH_TAB, { id });
  }

  async listTabs() {
    this.assertOpen('listTabs');
    return this.latestSnapshot?.tabs ?? [];
  }

  async activeTab() {
    this.assertOpen('activeTab');
    if (!this.latestSnapshot) {
      throw new NotSupportedError('activeTab', 'no snapshot yet');
    }
    return this.latestSnapshot.activeTab;
  }

  // --------------------------------------------------------------------
  // Per-tab navigation
  // --------------------------------------------------------------------

  async navigate(url: string, tab?: TabId): Promise<void> {
    this.assertOpen('navigate');
    await invoke(CMD_NAVIGATE, { url, tab: tab ?? null });
  }

  async goBack(tab?: TabId): Promise<void> {
    this.assertOpen('goBack');
    await invoke(CMD_GO_BACK, { tab: tab ?? null });
  }

  async goForward(tab?: TabId): Promise<void> {
    this.assertOpen('goForward');
    await invoke(CMD_GO_FORWARD, { tab: tab ?? null });
  }

  async reload(tab?: TabId): Promise<void> {
    this.assertOpen('reload');
    await invoke(CMD_RELOAD, { tab: tab ?? null });
  }

  // --------------------------------------------------------------------
  // Frame positioning (debounced to avoid hammering Rust during resize)
  // --------------------------------------------------------------------

  async setFrameRect(rect: BrowserFrameRect): Promise<void> {
    this.pendingRect = rect;
    if (this.setRectTimer !== null) return;
    // 16 ms trailing-edge debounce ≈ one animation frame. Trades off
    // a single frame of webview-position lag for far fewer Rust
    // round-trips during continuous resize.
    this.setRectTimer = window.setTimeout(async () => {
      this.setRectTimer = null;
      const next = this.pendingRect;
      this.pendingRect = null;
      if (!next) return;
      try {
        await invoke(CMD_SET_FRAME_RECT, { rect: next });
      } catch (e) {
        // Repositioning failures are non-fatal — log + keep going.
        console.warn('[TauriBrowserController] setFrameRect failed:', e);
      }
    }, 16);
  }

  async hideFrame(): Promise<void> {
    this.assertOpen('hideFrame');
    await invoke(CMD_HIDE_FRAME);
  }

  // --------------------------------------------------------------------
  // Subscription
  // --------------------------------------------------------------------

  subscribe(listener: (s: BrowserSnapshot) => void): () => void {
    this.subscribers.add(listener);
    // Emit the latest snapshot synchronously so consumers don't have
    // to read state separately.
    if (this.latestSnapshot) listener(this.latestSnapshot);
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

  // --------------------------------------------------------------------
  // Internal listener wiring
  // --------------------------------------------------------------------

  private async attachListeners(): Promise<void> {
    this.snapshotUnlisten = await listen<BrowserSnapshot>(EVT_SNAPSHOT, (e) => {
      this.latestSnapshot = e.payload;
      for (const sub of this.subscribers) sub(e.payload);
    });

    this.pageRequestUnlisten = await listen<{
      requestId: number;
      origin: string;
      tab: TabId;
      payload: unknown;
    }>(EVT_PAGE_REQUEST, async (event) => {
      const handler = this.pageRequestHandler;
      if (!handler) return;
      const pageReq: PageRequest = {
        origin: event.payload.origin,
        tab: event.payload.tab,
        request: event.payload.payload,
      };
      let response: unknown;
      try {
        response = await handler(pageReq);
      } catch (e) {
        response = {
          type: 'SMIRK_RESPONSE',
          v: 1,
          id: (event.payload.payload as { id?: number }).id ?? 0,
          error: {
            code: 'INTERNAL',
            message: e instanceof Error ? e.message : String(e),
          },
        };
      }
      // Route the response back to the originating tab via Rust.
      await invoke(CMD_RESPOND_PAGE_REQUEST, {
        requestId: event.payload.requestId,
        response,
      });
    });
  }

  private detachListeners(): void {
    this.snapshotUnlisten?.();
    this.snapshotUnlisten = null;
    this.pageRequestUnlisten?.();
    this.pageRequestUnlisten = null;
  }

  private assertOpen(op: string): void {
    if (!this.opened) {
      throw new NotSupportedError(op, 'controller is closed — call open() first');
    }
  }
}
