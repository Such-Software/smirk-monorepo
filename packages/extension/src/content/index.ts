/**
 * Content-script bridge. Runs in the content-script isolated world
 * (shares the page's DOM but not its JS globals). Three jobs:
 *
 *   1. Inject the page-context script (`inject.js`) into the page so
 *      it can define `window.smirk`. Done via a `<script>` tag with
 *      a chrome-extension://...inject.js src, allowed by the
 *      manifest's `web_accessible_resources`.
 *   2. Relay page → service-worker: listen for `SMIRK_REQUEST`
 *      messages from the page (window.postMessage), forward to the
 *      service worker via chrome.runtime.sendMessage.
 *   3. Relay service-worker → page: post the response back into the
 *      page so the page-context transport can resolve its Promise.
 *
 * **MV3 quirk: the SW can be evicted between request and response.**
 * chrome.runtime.sendMessage already handles re-spawning the SW per
 * call, so we don't need to keep a long-lived port open. Each
 * request is a fresh round-trip.
 *
 * **Cross-platform reuse note.** On Capacitor / Tauri there's no
 * content-script equivalent — the in-app browser → main-app message
 * channel goes through the platform's own bridge (Capacitor.WebView,
 * __TAURI__.event). This file is extension-only; the analogous
 * mobile/desktop bridges live in their respective platform packages.
 */

import {
  PROTOCOL_VERSION,
  SmirkWireRequest,
  SmirkWireResponse,
} from '@smirk/dapp-api';
import { isInjectDisabled } from '../background/dapp/inject-policy';

// --- Step 1: inject the page-context script (gated by user policy) ---
//
// document_start firing in the manifest means the page hasn't started
// executing its own scripts yet — we want our `<script src=...>` to
// run BEFORE the page's modules so `window.smirk` is defined when
// the dapp's detection code runs. Inserting into <html> works
// pre-<head>; falls back to documentElement otherwise.
//
// **Fingerprinting mitigation (issue #1).** Before we inject, check
// the user's policy. If they've disabled `window.smirk` in Settings,
// we skip injection AND skip the message relay below. The page sees
// no `window.smirk`, no postMessage chatter — there is nothing for a
// page (or a third-party tracker on a page) to fingerprint against.
// Storage read is async, so the message-relay listener install also
// has to wait until after the policy check resolves — otherwise the
// disabled state would still chatter on the page's message bus.
function injectPageScript() {
  try {
    const url = chrome.runtime.getURL('inject.js');
    const script = document.createElement('script');
    script.src = url;
    script.async = false;
    // Remove the tag after load so it doesn't pollute the page's
    // <head>. The script's side-effect (window.smirk assignment) has
    // already happened by then.
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  } catch (e) {
    console.warn('[smirk-content] failed to inject page script', e);
  }
}

void (async () => {
  if (await isInjectDisabled()) {
    // User has globally disabled web-API injection. Do nothing —
    // not even register the message listener. We want zero
    // observable footprint on the page in this mode.
    return;
  }
  injectPageScript();
  installMessageRelay();
})();

// --- Step 2 + 3: relay messages between page and service worker ---

function installMessageRelay(): void {

  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const data = ev.data as Partial<SmirkWireRequest> | null;
    if (
      !data ||
      data.type !== 'SMIRK_REQUEST' ||
      typeof data.id !== 'number' ||
      data.v !== PROTOCOL_VERSION
    ) {
      return;
    }
    // Forward to the service worker. The SW handler will respond with
    // a SmirkWireResponse envelope (or throw, which we surface as an
    // INTERNAL error envelope so the page-side promise can reject).
    chrome.runtime.sendMessage(data, (resp: SmirkWireResponse | undefined) => {
      const lastError = chrome.runtime.lastError;
      if (lastError || !resp) {
        // Translate chrome.runtime errors into a wire-shaped error so
        // the page-side transport can resolve and the page can branch
        // on the error code like any other failure.
        const errResp: SmirkWireResponse = {
          type: 'SMIRK_RESPONSE',
          v: PROTOCOL_VERSION,
          id: data.id as number,
          error: {
            code: 'INTERNAL',
            message: lastError?.message ?? 'no response from service worker',
          },
        };
        window.postMessage(errResp, '*');
        return;
      }
      window.postMessage(resp, '*');
    });
  });
}
