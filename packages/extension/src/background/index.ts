/**
 * Smirk background service worker.
 *
 * Four jobs:
 *   1. The dapp bridge: relays `window.smirk` calls from content
 *      scripts into the `@such-software/smirk-dapp-api` wallet-handler, which
 *      checks permissions and opens approval popups as needed.
 *   2. Generic service-worker commands (`PING`), which share the message
 *      channel with the dapp bridge but never overlap: the dispatcher filters
 *      by message discriminator and the PING listener is registered first so
 *      it is never starved.
 *   3. The jobs coordinator: the background job system (PoW solve, swap
 *      polls), over message + Port listeners.
 *   4. The DM watcher: an alarm-driven poll of the Nostr relay for encrypted
 *      gift-wraps, raising notifications. No key here; the popup decrypts.
 *
 * MV3 service workers can't statically import WASM; `@smirk/wasm`
 * imports must stay dynamic (`await import('@smirk/wasm')`). When
 * the SW grows crypto-using flows that don't go through the popup,
 * follow that pattern.
 */

import { api, CORE_PACKAGE_VERSION } from '@smirk/core';

import { bootBackendSelection } from '../backend-boot';
import { installDappBridge } from './dapp/dispatch';
import { installDmWatcher } from './dm-watch';
import { installJobsCoordinator } from './jobs/coordinator';

// Point the API at the configured backend: build default → durable user
// selection → re-applied on a cross-context switch. See backend-boot.ts.
bootBackendSelection();

// Diagnostic breadcrumbs at SW startup + install. `console.debug`
// keeps these out of the default extension console view; developers
// debugging the service worker see them with "Verbose" enabled.
console.debug('[smirk] background worker starting', {
  core: CORE_PACKAGE_VERSION,
});

chrome.runtime.onInstalled.addListener(() => {
  console.debug('[smirk] installed; api base:', (api as unknown as { baseUrl: string }).baseUrl);
});

// PING listener: registered FIRST so the dapp bridge's
// `return true` (keep-channel-open) semantics never starve the
// synchronous PING reply. Order matters here: Chrome calls
// listeners in registration order and stops at the first one that
// returns truthy.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'PING') {
    sendResponse({ ok: true, core: CORE_PACKAGE_VERSION });
    return true;
  }
  // Not a PING: fall through to other listeners (the dapp bridge).
  return false;
});

installDappBridge();

// Jobs coordinator: drives the background job system (PoW solve,
// future Grin finalize, swap polls, etc.). Installs message + Port
// listeners; no synchronous side effects until a popup connects.
installJobsCoordinator();

// Background DM delivery: alarm-driven poll of the Nostr relay for encrypted
// gift-wraps (+ notifications). No key here; the popup decrypts. No-op until the
// popup sets a watch config on unlock.
installDmWatcher();
