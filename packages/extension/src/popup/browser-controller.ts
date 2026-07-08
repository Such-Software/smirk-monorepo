/**
 * Shape of the embedded-browser controller the desktop shell exposes
 * on the global. Structurally compatible with `DappBrowserController`
 * from `@smirk/dapp-browser`, but typed locally to avoid the
 * extension package having to depend on `@smirk/dapp-browser`.
 */
export type BrowserControllerGlobal = Parameters<
  typeof import('@smirk/ui').BrowserShell
>[0]['controller'];

// Imported as a type only — the actual class lives in
// `@smirk/dapp-browser` and is instantiated by `@smirk/desktop`'s
// `main.ts`. BrowseTab only needs the structural shape (the
// `inlineMode` brand + `dispatchPageMessage` / `getReloadGen` /
// `notifyTabLoaded` methods) when narrowing the controller to
// pass into `<IframeBrowserContent>`.
export type IframeBrowserController = import('@smirk/dapp-browser').IframeBrowserController;

// Read the embedded-browser controller the desktop shell installed on
// boot. `undefined` on extension builds — the BottomNav and routing
// branch on this. The narrow inline cast is the only place in the
// extension that touches the global; downstream code uses
// `browserController` instead.
export const browserController: BrowserControllerGlobal | undefined =
  (globalThis as { __smirk_browser__?: BrowserControllerGlobal }).__smirk_browser__;
