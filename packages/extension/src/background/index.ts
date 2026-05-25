/**
 * Smirk background service worker.
 *
 * Two main jobs in v0.3 (more to come as flows port over):
 *   1. The dapp bridge — relays `window.smirk` calls from content
 *      scripts into the `@smirk/dapp-api` wallet-handler, which
 *      checks permissions and opens approval popups as needed.
 *   2. Generic SW commands (`PING`, future alarms, future
 *      notifications) — these live alongside the dapp bridge but
 *      never overlap (the dispatcher filters by message
 *      discriminator).
 *
 * MV3 service workers can't statically import WASM — `@smirk/wasm`
 * imports must stay dynamic (`await import('@smirk/wasm')`). When
 * the SW grows crypto-using flows that don't go through the popup,
 * follow that pattern.
 */

import { api, CORE_PACKAGE_VERSION } from '@smirk/core';

import { installDappBridge } from './dapp/dispatch';

console.log('[smirk] background worker starting', {
  core: CORE_PACKAGE_VERSION,
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[smirk] installed; api base:', (api as unknown as { baseUrl: string }).baseUrl);
});

// PING listener — registered FIRST so the dapp bridge's
// `return true` (keep-channel-open) semantics never starve the
// synchronous PING reply. Order matters here: Chrome calls
// listeners in registration order and stops at the first one that
// returns truthy.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'PING') {
    sendResponse({ ok: true, core: CORE_PACKAGE_VERSION });
    return true;
  }
  // Not a PING — fall through to other listeners (the dapp bridge).
  return false;
});

installDappBridge();
