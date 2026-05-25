/**
 * @smirk/dapp-api — transport-agnostic dapp-injection layer.
 *
 * Three layers:
 *   1. Protocol (protocol.ts) — JSON-RPC-shaped wire types shared by
 *      page-side and wallet-side. Single source of truth for what
 *      `window.smirk` can do.
 *   2. Page-side (page-api.ts) — `installSmirkApi(window, transport)`
 *      defines `window.smirk`. Transport is platform-supplied:
 *      postMessage for browser/Capacitor, Tauri event bridge for
 *      desktop.
 *   3. Wallet-side (wallet-handler.ts) — `createWalletHandler({...})`
 *      returns a dispatcher that consumes wire requests, runs
 *      permission checks + approval prompts, and produces wire
 *      responses. Pluggable provider / permissions / approval
 *      interfaces.
 *
 * Platform adapters live OUTSIDE this package (in `packages/extension`
 * for MV3, in `packages/mobile` for Capacitor when that lands).
 *
 * @example chrome MV3 service worker
 * ```ts
 * const dispatch = createWalletHandler({
 *   provider: chromeWalletProvider(),
 *   permissions: chromeStoragePermissionStore(),
 *   approval: chromePopupApprovalHandler(),
 * });
 * chrome.runtime.onMessage.addListener((msg, sender, send) => {
 *   if (msg?.type !== 'SMIRK_REQUEST') return;
 *   dispatch(msg, originContextFrom(sender)).then(send);
 *   return true;  // async
 * });
 * ```
 */

export * from './protocol';
export * from './page-api';
export * from './permissions';
export * from './provider';
export * from './approval';
export * from './wallet-handler';
