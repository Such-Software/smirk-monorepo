/**
 * Glue between the embedded-browser controller's `PageRequest`
 * surface and the dapp-api `WalletHandlerDispatch`.
 *
 * The Tauri side (and future Capacitor side) hands us a `PageRequest`
 * — `{origin, tab, request}` where `request` is opaque. We narrow it
 * to a `SmirkWireRequest`, dispatch through the wallet handler with
 * the page's origin as `OriginContext`, and return the resulting
 * `SmirkWireResponse`. The controller routes the response back to
 * the originating tab via the transport's response channel.
 *
 * Why a thin standalone bridge instead of inlining into BrowseTab:
 * keeps the React component free of protocol-version handling and
 * malformed-payload defenses, and reusable from any consumer that
 * wires a `WalletHandlerDispatch` into a controller (Capacitor
 * later, headless tests today).
 */

import {
  PROTOCOL_VERSION,
  type OriginContext,
  type SmirkMethod,
  type SmirkWireRequest,
  type SmirkWireResponse,
  type WalletHandlerDispatch,
} from '@smirk/dapp-api';

/**
 * Structural mirror of `@smirk/dapp-browser`'s `PageRequest`. We
 * don't import the type because `@smirk/extension` is platform-
 * agnostic and `@smirk/dapp-browser` is a desktop/mobile concern.
 * The structural shape is intentionally tiny and stable.
 */
export interface PageRequest {
  readonly origin: string;
  readonly tab: string;
  readonly request: unknown;
}

function isWireRequest(m: unknown): m is SmirkWireRequest {
  if (m === null || typeof m !== 'object') return false;
  const r = m as Record<string, unknown>;
  return (
    r.type === 'SMIRK_REQUEST' &&
    typeof r.id === 'number' &&
    typeof r.v === 'number' &&
    typeof r.method === 'string'
  );
}

/**
 * Build a `PageRequestHandler` from a `WalletHandlerDispatch`. The
 * returned function is what callers pass to
 * `controller.setPageRequestHandler(...)`.
 *
 * Malformed requests get a `PROTOCOL_MISMATCH` envelope so the page
 * sees a typed error rather than a silent hang.
 */
export function createPageRequestBridge(
  dispatch: WalletHandlerDispatch,
): (req: PageRequest) => Promise<unknown> {
  return async (req: PageRequest): Promise<unknown> => {
    const wire = req.request;
    if (!isWireRequest(wire)) {
      return {
        type: 'SMIRK_RESPONSE',
        v: PROTOCOL_VERSION,
        // best-effort id pass-through; some malformed payloads will
        // lack it entirely and the page side just drops the response.
        id:
          typeof (wire as { id?: unknown })?.id === 'number'
            ? (wire as { id: number }).id
            : 0,
        error: {
          code: 'PROTOCOL_MISMATCH',
          message: 'Page sent a request that did not match the SMIRK wire format',
        },
      } satisfies SmirkWireResponse;
    }
    const origin: OriginContext = { origin: req.origin };
    return await dispatch<SmirkMethod>(wire, origin);
  };
}
