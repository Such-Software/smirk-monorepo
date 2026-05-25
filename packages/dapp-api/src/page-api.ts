/**
 * Page-context API surface. Returns the object that lives at
 * `window.smirk`. Transport is injected, so the same factory runs:
 *
 *   - Browser extension: window.postMessage → content script → SW
 *   - Capacitor in-app browser: window.postMessage → main app via
 *     Capacitor's WebView listener
 *   - Tauri WebView: window.postMessage → __TAURI__ event bridge
 *
 * The page never sees private keys or asset state — it sees only the
 * methods declared in `SmirkMethodMap`. Every call round-trips through
 * the transport to a wallet-side handler that does permission checks
 * + optional user approval before returning.
 */

import {
  PROTOCOL_VERSION,
  SmirkAddresses,
  SmirkAsset,
  SmirkMethod,
  SmirkMethodMap,
  SmirkPaymentRequest,
  SmirkPaymentResult,
  SmirkPublicKeys,
  SmirkRpcError,
  SmirkSignResult,
  SmirkClaimResult,
  SmirkWireRequest,
  SmirkWireResponse,
} from './protocol';

/** Function the page-api calls to send a request and await the
 *  matching response. Adapter-supplied. Adapter is responsible for:
 *    - serializing/deserializing,
 *    - matching responses to requests by id,
 *    - timing out if the wallet is slow / absent.
 *  Throwing converts to `SmirkRpcError('INTERNAL', ...)`. */
export type SmirkPageTransport = <M extends SmirkMethod>(
  req: SmirkWireRequest<M>,
) => Promise<SmirkWireResponse<M>>;

/** The shape consumers will see at `window.smirk`. Mirrors the legacy
 *  v0.2.x surface so existing dapps (smirk.cash, claim pages) keep
 *  working unchanged. */
export interface SmirkPageApi {
  /** Stable marker for feature detection (`if (window.smirk?.isSmirk)`). */
  readonly isSmirk: true;
  /** Protocol version this page surface speaks. Pages can branch on
   *  this to use newer features when available without breaking on
   *  older wallets. */
  readonly version: number;
  connect(assets?: SmirkAsset[]): Promise<SmirkPublicKeys>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  getPublicKeys(): Promise<SmirkPublicKeys | null>;
  getAddresses(): Promise<SmirkAddresses | null>;
  signMessage(message: string): Promise<SmirkSignResult>;
  requestPayment(request: SmirkPaymentRequest): Promise<SmirkPaymentResult>;
  claimPublicTip(tipId: string, fragmentKey: string): Promise<SmirkClaimResult>;
}

let nextRequestId = 0;

export function createSmirkPageApi(transport: SmirkPageTransport): SmirkPageApi {
  async function call<M extends SmirkMethod>(
    method: M,
    params: SmirkMethodMap[M]['params'],
  ): Promise<SmirkMethodMap[M]['result']> {
    const req: SmirkWireRequest<M> = {
      type: 'SMIRK_REQUEST',
      v: PROTOCOL_VERSION,
      id: ++nextRequestId,
      method,
      params,
    };
    let resp: SmirkWireResponse<M>;
    try {
      resp = await transport(req);
    } catch (e) {
      throw new SmirkRpcError(
        'INTERNAL',
        e instanceof Error ? e.message : 'transport failed',
      );
    }
    if (resp.error) {
      throw new SmirkRpcError(resp.error.code, resp.error.message);
    }
    if (resp.result === undefined) {
      throw new SmirkRpcError(
        'INTERNAL',
        'wallet returned no result and no error',
      );
    }
    return resp.result;
  }

  // The returned object is frozen so a page can't reach in and mutate
  // it (e.g., swap out our `connect` for theirs to harvest keys).
  // Property descriptors are non-configurable, non-writable.
  const api: SmirkPageApi = Object.freeze({
    isSmirk: true as const,
    version: PROTOCOL_VERSION,
    connect: (assets?: SmirkAsset[]) =>
      call('connect', assets ? { assets } : {}),
    disconnect: async () => {
      await call('disconnect', {});
    },
    isConnected: () => call('isConnected', {}),
    getPublicKeys: () => call('getPublicKeys', {}),
    getAddresses: () => call('getAddresses', {}),
    signMessage: (message: string) => call('signMessage', { message }),
    requestPayment: (request: SmirkPaymentRequest) =>
      call('requestPayment', request),
    claimPublicTip: (tipId: string, fragmentKey: string) =>
      call('claimPublicTip', { tipId, fragmentKey }),
  });

  return api;
}

/** Install the API at `window.smirk` and dispatch the `smirk-ready`
 *  event. Idempotent — if `window.smirk` already exists (another
 *  Smirk instance is running, somehow) we skip rather than overwrite.
 *
 *  Pages that mount their detection listener AFTER our inject runs
 *  miss the dispatched event, so they MUST also do a sync presence
 *  check (`if (window.smirk) ...`). This is documented in the
 *  `smirk.d.ts` type file shipped to dapps. */
export function installSmirkApi(
  target: Window,
  transport: SmirkPageTransport,
): SmirkPageApi | null {
  if ((target as { smirk?: unknown }).smirk) {
    // Another instance already installed. Don't clobber — could be a
    // legacy v0.2.x extension that's installed alongside v0.3, or a
    // dev-mode duplicate. Either way the user has chosen which is
    // canonical.
    return null;
  }
  const api = createSmirkPageApi(transport);
  Object.defineProperty(target, 'smirk', {
    value: api,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  target.dispatchEvent(new CustomEvent('smirk-ready'));
  return api;
}
