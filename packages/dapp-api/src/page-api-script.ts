/**
 * Embedded-browser injection helpers.
 *
 * Browser controllers (`@smirk/dapp-browser`) accept init scripts as
 * raw strings; they don't import any other package. This module
 * provides the strings needed to bootstrap `window.smirk` inside an
 * embedded webview without the controller having to know about the
 * dapp-api package.
 *
 * The script is built at runtime (not bundled at build time) because
 * each platform's transport is different, so the IIFE that runs in
 * the page needs to know which postMessage channel / Tauri event /
 * Capacitor bridge to use. The platform-specific channel name is
 * passed in via {@link InjectionScriptOptions}.
 *
 * Why a raw string instead of an `installSmirkApi()` import: the
 * embedded page runs in a different origin and module realm from the
 * wallet. We cannot import the wallet's modules in the page; we have
 * to ship the bootstrap code as a self-contained IIFE.
 *
 * @example desktop wiring
 *
 * ```ts
 * import { getPageApiInjectionScript } from '@such-software/smirk-dapp-api';
 * import { TauriBrowserController } from './tauri-browser-controller';
 *
 * const script = getPageApiInjectionScript({
 *   transport: { kind: 'tauri', event: 'smirk:dapp-rpc' },
 * });
 * const controller = new TauriBrowserController();
 * await controller.setInitScripts([script]);
 * ```
 */

/**
 * Configuration for the injection script. Each variant maps to a
 * transport implementation the wallet shell wires up on the other
 * end of the channel.
 */
export type InjectionScriptOptions = {
  readonly transport: InjectionTransport;
};

/**
 * Transport descriptor: names the channel the injected page-side
 * code uses to send wire-format messages to the wallet.
 *
 * - `postMessage`: posts to `window.parent.postMessage(msg, '*')`,
 *   typed by `channel`. Used when the embedded page lives inside an
 *   iframe (e.g. for tests).
 * - `tauri`: emits `window.__TAURI__.event.emit(event, payload)`.
 *   Used by `TauriBrowserController`.
 * - `capacitor`: calls `window.SmirkBrowserBridge.send(json)` (the
 *   custom plugin's JS interface). Used by
 *   `CapacitorBrowserController`.
 */
export type InjectionTransport =
  | { readonly kind: 'postMessage'; readonly channel: string }
  | { readonly kind: 'tauri'; readonly event: string }
  | { readonly kind: 'capacitor'; readonly bridgeName: string };

/**
 * Build the IIFE source that, when injected at document-start into an
 * embedded page, installs `window.smirk` against the configured
 * transport.
 *
 * The returned string is safe to pass to
 * `DappBrowserController.setInitScripts([script])`. The IIFE captures
 * no closures; it's a pure self-contained payload.
 *
 * Threat model: the page may try to override `window.smirk` after
 * we install it. We use `defineProperty` with `writable: false,
 * configurable: false` to make that throw in strict mode and silently
 * fail otherwise, same posture as `installSmirkApi()` (page-api.ts).
 */
export function getPageApiInjectionScript(
  options: InjectionScriptOptions,
): string {
  const transport = options.transport;
  const safeJson = (v: unknown): string => JSON.stringify(v);
  const transportLiteral = safeJson(transport);

  // The script body is concatenated as a string. Keep it small:
  // every embedded webview pays the parse cost on every navigation.
  // The wallet handler does the real work; this IIFE is just the
  // wire transport plus a Promise-tracking dispatcher.
  return [
    '(function smirkBootstrap(){',
    'if (window.smirk) return;',
    `var TRANSPORT = ${transportLiteral};`,
    'var pending = new Map();',
    'var nextId = 1;',
    'function makeRequest(method, params){',
    '  return new Promise(function(resolve, reject){',
    '    var id = nextId++;',
    "    pending.set(id, { resolve: resolve, reject: reject });",
    '    var msg = { type: "SMIRK_REQUEST", v: 1, id: id, method: method, params: params };',
    '    sendToWallet(msg);',
    '  });',
    '}',
    'function sendToWallet(msg){',
    '  if (TRANSPORT.kind === "postMessage"){',
    '    window.parent.postMessage({ channel: TRANSPORT.channel, payload: msg }, "*");',
    '  } else if (TRANSPORT.kind === "tauri"){',
    '    var T = window.__TAURI__;',
    '    if (T && T.event && typeof T.event.emit === "function"){',
    '      T.event.emit(TRANSPORT.event, msg);',
    '    } else {',
    '      pending.get(msg.id) && pending.get(msg.id).reject(new Error("Tauri bridge unavailable"));',
    '    }',
    '  } else if (TRANSPORT.kind === "capacitor"){',
    '    var bridge = window[TRANSPORT.bridgeName];',
    '    if (bridge && typeof bridge.send === "function"){',
    '      bridge.send(JSON.stringify(msg));',
    '    } else {',
    '      pending.get(msg.id) && pending.get(msg.id).reject(new Error("Capacitor bridge unavailable"));',
    '    }',
    '  }',
    '}',
    'function handleResponse(resp){',
    '  if (!resp || resp.type !== "SMIRK_RESPONSE") return;',
    '  var pendingPromise = pending.get(resp.id);',
    '  if (!pendingPromise) return;',
    '  pending.delete(resp.id);',
    '  if (resp.error){',
    '    var err = new Error(resp.error.message || "Smirk wallet error");',
    '    err.code = resp.error.code;',
    '    pendingPromise.reject(err);',
    '  } else {',
    '    pendingPromise.resolve(resp.result);',
    '  }',
    '}',
    // Wire response listener appropriately per transport.
    'if (TRANSPORT.kind === "postMessage"){',
    '  window.addEventListener("message", function(ev){',
    '    if (!ev.data || ev.data.channel !== TRANSPORT.channel) return;',
    '    handleResponse(ev.data.payload);',
    '  });',
    '} else if (TRANSPORT.kind === "tauri"){',
    '  var T = window.__TAURI__;',
    '  if (T && T.event && typeof T.event.listen === "function"){',
    '    T.event.listen(TRANSPORT.event + ":response", function(ev){',
    '      handleResponse(ev.payload);',
    '    });',
    '  }',
    '} else if (TRANSPORT.kind === "capacitor"){',
    '  window.addEventListener("message", function(ev){',
    '    if (!ev.data || ev.data.bridge !== TRANSPORT.bridgeName) return;',
    '    handleResponse(ev.data.payload);',
    '  });',
    '}',
    // The window.smirk surface itself. Mirror the methods declared in
    // `page-api.ts::SmirkPageApi`. Update both together when methods
    // are added.
    'var api = {',
    '  isInstalled: function(){ return true; },',
    '  protocolVersion: function(){ return 1; },',
    '  isUnlocked: function(){ return makeRequest("isUnlocked"); },',
    '  connect: function(assets){ return makeRequest("connect", { assets: assets }); },',
    '  getAddresses: function(assets){ return makeRequest("getAddresses", { assets: assets }); },',
    '  getPublicKeys: function(assets){ return makeRequest("getPublicKeys", { assets: assets }); },',
    '  signMessage: function(message, assets){ return makeRequest("signMessage", { message: message, assets: assets }); },',
    '  requestPayment: function(req){ return makeRequest("requestPayment", req); },',
    '  claimPublicTip: function(tipId, fragmentKey){ return makeRequest("claimPublicTip", { tipId: tipId, fragmentKey: fragmentKey }); },',
    '};',
    'Object.defineProperty(window, "smirk", { value: api, writable: false, configurable: false, enumerable: true });',
    'window.dispatchEvent(new CustomEvent("smirk-ready"));',
    '})();',
  ].join('\n');
}
