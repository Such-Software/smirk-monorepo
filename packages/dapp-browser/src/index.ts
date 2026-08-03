/**
 * `@smirk/dapp-browser`: embedded-browser shell abstraction for
 * Smirk's desktop (Tauri) and mobile (Capacitor) wallets.
 *
 * See [docs/EMBEDDED_BROWSER.md](../../../docs/EMBEDDED_BROWSER.md)
 * for the architectural rationale and the package's place in the
 * broader system.
 */

export type {
  BrowserFrameRect,
  BrowserNavigationState,
  BrowserTab,
  PageRequest,
  PageRequestHandler,
  TabId,
} from './types';
export { NotSupportedError, UnknownTabError, makeTabId } from './types';

export type { BrowserSnapshot, DappBrowserController } from './controller';

export type { HistoryEntry, HistoryStore } from './history';
export { InMemoryHistoryStore } from './history';

export type { Bookmark, BookmarkStore } from './bookmarks';
export { InMemoryBookmarkStore } from './bookmarks';

export type { MockControllerOptions } from './mock-controller';
export { MockController } from './mock-controller';

export type {
  IframeControllerOptions,
  InlineModeController,
} from './iframe-controller';
export { IframeBrowserController } from './iframe-controller';
