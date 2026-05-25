/**
 * Page-context bootstrap. Runs in EVERY page the user visits (via
 * the content-script-relayed inject), defines `window.smirk`, and
 * wires its transport to `window.postMessage`.
 *
 * **Why this file is separate from the content script.** Content
 * scripts run in an isolated world — they share the page's DOM but
 * NOT its `window` object. To expose `window.smirk` to page-side
 * JS we have to either (a) inject this script as a `<script>` tag
 * from the content script, OR (b) use chrome.scripting.executeScript
 * in MAIN world from the service worker. We use (a) because (b)
 * doesn't reliably fire at document_start (race with page scripts).
 *
 * **Bundle format.** IIFE, no module imports — page CSP often
 * forbids `<script type="module">` from non-self origins. Vite config
 * outputs this entry as `iife` format.
 *
 * **Cross-platform target.** Same file gets reused as the page-context
 * bootstrap in Capacitor's in-app browser (transport changes to
 * Capacitor.WebView messageHandler) and Tauri WebView (transport
 * changes to __TAURI__ event bridge). The `installSmirkApi` core +
 * postMessage pattern stays.
 */

import {
  installSmirkApi,
  PROTOCOL_VERSION,
  SmirkPageTransport,
  SmirkWireRequest,
  SmirkWireResponse,
} from '@smirk/dapp-api';

interface PendingRequest {
  resolve: (resp: SmirkWireResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingRequest>();

// Wallet operations involve user prompts that the user may take a
// long time to approve. Cap timeout high enough that no real human
// flow hits it (5 minutes mirrors MetaMask's window.ethereum
// behavior). Connect/sign typically resolve in seconds.
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

window.addEventListener('message', (ev: MessageEvent) => {
  // event.source === window: filter out messages from other frames
  // (iframes, popouts) — we only respond to our own page's traffic.
  if (ev.source !== window) return;
  const data = ev.data as Partial<SmirkWireResponse> | null;
  if (
    !data ||
    data.type !== 'SMIRK_RESPONSE' ||
    typeof data.id !== 'number' ||
    data.v !== PROTOCOL_VERSION
  ) {
    return;
  }
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  clearTimeout(p.timer);
  p.resolve(data as SmirkWireResponse);
});

// Generic at the call boundary — the JS body is the same for every M
// (we just round-trip the envelope), so the function is generic and
// returns the typed response the caller asked for. Without the generic
// header here, TS rejects the assignment against `SmirkPageTransport`
// which is itself generic.
const transport: SmirkPageTransport = <M extends Parameters<SmirkPageTransport>[0]['method']>(
  req: SmirkWireRequest<M>,
) => {
  return new Promise<SmirkWireResponse<M>>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(req.id);
      reject(new Error('Smirk request timed out'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(req.id, {
      resolve: resolve as (resp: SmirkWireResponse) => void,
      reject,
      timer,
    });
    // postMessage origin '*' is fine: the content script filters by
    // event.source === window AND by the `SMIRK_REQUEST` discriminator,
    // and we don't include any sensitive data in the request body
    // (everything sensitive lives in the wallet, not the request).
    window.postMessage(req, '*');
  });
};

installSmirkApi(window, transport);
