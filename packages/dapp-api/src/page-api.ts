/**
 * Page-context API surface. Returns the object that lives at
 * `window.smirk`. Transport is injected, so the same factory runs:
 *
 *   - Browser extension: window.postMessage → content script → SW
 *   - Capacitor in-app browser: window.postMessage → main app via
 *     Capacitor's WebView listener
 *   - Tauri WebView: window.postMessage → __TAURI__ event bridge
 *
 * The page never sees private keys or asset state; it sees only the
 * methods declared in `SmirkMethodMap`. Every call round-trips through
 * the transport to a wallet-side handler that does permission checks
 * + optional user approval before returning.
 */

import {
  PROTOCOL_VERSION,
  SmirkAddresses,
  SmirkAppEncryptionKey,
  SmirkAsset,
  SmirkBackend,
  SmirkMethod,
  SmirkMethodMap,
  SmirkNostrSignedEvent,
  SmirkNostrUnsignedEvent,
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
  /** The backend the wallet is pointed at (so a page talks to the user's
   *  chosen backend instead of hardcoding one). */
  getBackend(): Promise<SmirkBackend>;
  /** The user's Nostr public key (x-only hex). Prompts a one-time grant the
   *  first time an origin asks (npub disclosure is opt-in per origin). */
  getNostrPublicKey(): Promise<string | null>;
  /** Ask the wallet to schnorr-sign a Nostr event (NIP-98 login, a note, …).
   *  Requires the Nostr scope; prompts per signature. */
  signNostrEvent(event: SmirkNostrUnsignedEvent): Promise<SmirkNostrSignedEvent>;
  /** The origin's app-scoped e2ee sealing key (x25519). Seal to `publicKey` with
   *  libsodium `crypto_box_seal` for storage only the user can read. Prompts a
   *  one-time grant the first time an origin asks; `context` sub-scopes the key.
   *  `null` if the user declines. */
  getAppEncryptionKey(context?: string): Promise<SmirkAppEncryptionKey | null>;
  /** Open a `crypto_box_seal` envelope addressed to this origin's app key,
   *  returning the plaintext bytes. Requires the e2ee scope (call
   *  `getAppEncryptionKey` first). `sealed` may be base64 or raw bytes. */
  appSealOpen(sealed: Uint8Array | string, context?: string): Promise<Uint8Array>;
}

/** Uint8Array → base64 (wire form). Small + dependency-free; runs in page,
 *  SW, and Tauri webview contexts alike. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** base64 → Uint8Array (inverse of `bytesToBase64`). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let nextRequestId = 0;

/** One request/response round-trip over the adapter transport. Shared by the
 *  `window.smirk` surface and the `window.nostr` (NIP-07) surface. */
function makeCaller(transport: SmirkPageTransport) {
  return async function call<M extends SmirkMethod>(
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
      throw new SmirkRpcError('INTERNAL', e instanceof Error ? e.message : 'transport failed');
    }
    if (resp.error) {
      throw new SmirkRpcError(resp.error.code, resp.error.message);
    }
    if (resp.result === undefined) {
      throw new SmirkRpcError('INTERNAL', 'wallet returned no result and no error');
    }
    return resp.result;
  };
}

export function createSmirkPageApi(transport: SmirkPageTransport): SmirkPageApi {
  const call = makeCaller(transport);

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
    getBackend: () => call('getBackend', {}),
    getNostrPublicKey: () => call('getNostrPublicKey', {}),
    signNostrEvent: (event: SmirkNostrUnsignedEvent) =>
      call('signNostrEvent', { event }),
    getAppEncryptionKey: (context?: string) =>
      call('getAppEncryptionKey', context !== undefined ? { context } : {}),
    appSealOpen: async (sealed: Uint8Array | string, context?: string) => {
      const sealedB64 = typeof sealed === 'string' ? sealed : bytesToBase64(sealed);
      const res = await call('appSealOpen', {
        sealed: sealedB64,
        ...(context !== undefined ? { context } : {}),
      });
      return base64ToBytes(res.plaintext);
    },
  });

  return api;
}

/**
 * Standard NIP-07 provider: the `window.nostr` object any Nostr app (Magick
 * Market, etc.) expects, so Smirk works as a Nostr signer out of the box.
 * `getPublicKey`/`signEvent` route to the SAME wallet-side Nostr methods as
 * `window.smirk`; `nip44`/`nip04` add DM encrypt/decrypt. This is the interop
 * lane for "log in / pay on Magick Market with Smirk".
 */
export interface SmirkNostrProvider {
  getPublicKey(): Promise<string>;
  signEvent(event: SmirkNostrUnsignedEvent): Promise<SmirkNostrSignedEvent>;
  nip44: {
    encrypt(peer: string, plaintext: string): Promise<string>;
    decrypt(peer: string, ciphertext: string): Promise<string>;
  };
  /** Legacy scheme; some older dapps still use it. */
  nip04: {
    encrypt(peer: string, plaintext: string): Promise<string>;
    decrypt(peer: string, ciphertext: string): Promise<string>;
  };
  getRelays(): Promise<Record<string, { read: boolean; write: boolean }>>;
}

export function createNip07Provider(transport: SmirkPageTransport): SmirkNostrProvider {
  const call = makeCaller(transport);
  const getPublicKey = async (): Promise<string> => {
    const pk = await call('getNostrPublicKey', {});
    if (!pk) throw new SmirkRpcError('NOT_AUTHORIZED', 'No Nostr identity available');
    return pk;
  };
  return Object.freeze({
    getPublicKey,
    signEvent: (event: SmirkNostrUnsignedEvent) => call('signNostrEvent', { event }),
    nip44: Object.freeze({
      encrypt: (peer: string, plaintext: string) =>
        call('nostrEncrypt', { peer, plaintext, scheme: 'nip44' }),
      decrypt: (peer: string, ciphertext: string) =>
        call('nostrDecrypt', { peer, ciphertext, scheme: 'nip44' }),
    }),
    nip04: Object.freeze({
      encrypt: (peer: string, plaintext: string) =>
        call('nostrEncrypt', { peer, plaintext, scheme: 'nip04' }),
      decrypt: (peer: string, ciphertext: string) =>
        call('nostrDecrypt', { peer, ciphertext, scheme: 'nip04' }),
    }),
    // The wallet doesn't impose a relay list on the dapp; it uses its own.
    getRelays: async () => ({}),
  });
}

/** Install the API at `window.smirk` and dispatch the `smirk-ready`
 *  event. Idempotent: if `window.smirk` already exists (another
 *  Smirk instance is running, somehow) we skip rather than overwrite.
 *
 *  Pages that mount their detection listener AFTER our inject runs
 *  miss the dispatched event, so they MUST also do a sync presence
 *  check (`if (window.smirk) ...`). */
export function installSmirkApi(
  target: Window,
  transport: SmirkPageTransport,
): SmirkPageApi | null {
  if ((target as { smirk?: unknown }).smirk) {
    // Another instance already installed. Don't clobber: could be a
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
  // Also expose the standard NIP-07 provider at `window.nostr`, but ONLY if no
  // other signer already claimed it (Alby, nos2x, another Nostr extension). We
  // never clobber the user's chosen signer; if one exists, Smirk is reachable via
  // window.smirk and the user can disable the other extension to make us primary.
  if (!(target as { nostr?: unknown }).nostr) {
    try {
      Object.defineProperty(target, 'nostr', {
        value: createNip07Provider(transport),
        writable: false,
        configurable: true, // configurable so a later-loading signer can still take over
        enumerable: true,
      });
    } catch {
      /* another provider defined it non-configurably between the check + set */
    }
  }
  target.dispatchEvent(new CustomEvent('smirk-ready'));
  return api;
}
