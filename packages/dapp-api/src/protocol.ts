/**
 * Wire protocol between page-context `window.smirk` and wallet-side
 * handler. JSON-RPC-shaped envelope so any transport (postMessage,
 * Capacitor messageHandler, Tauri IPC) can carry it without
 * additional encoding.
 *
 * **Versioning.** `PROTOCOL_VERSION` bumps on any breaking shape
 * change. Page-api and wallet-handler both ship the version they
 * understand; mismatches fail closed with a clear error. We don't
 * negotiate down — old clients should be left talking to old
 * handlers, not silently degraded.
 *
 * **No transport details in here.** Anything platform-specific
 * (`chrome.runtime.*`, `Capacitor.*`, `__TAURI__`) lives in the
 * platform adapter, not in this package.
 */

export const PROTOCOL_VERSION = 1 as const;

/** App-scoped e2ee envelope scheme. Must match `@smirk/core`'s `APP_ENC_SCHEME`
 *  (libsodium `crypto_box_seal`, x25519 sealed box). Duplicated here so this
 *  published protocol package stays decoupled from wallet internals. */
export const APP_ENC_SCHEME = 'x25519-sealedbox' as const;

/** Asset namespace shared with the rest of @smirk. */
export type SmirkAsset = 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin';
export const ALL_ASSETS: readonly SmirkAsset[] = [
  'btc',
  'ltc',
  'xmr',
  'wow',
  'grin',
] as const;

/** Per-asset value-or-null map. `null` means the wallet doesn't have
 *  a key for that asset OR the origin isn't authorized for it. */
export interface SmirkPublicKeys {
  btc: string | null;
  ltc: string | null;
  xmr: string | null;
  wow: string | null;
  grin: string | null;
}

export interface SmirkAddresses {
  btc: string | null;
  ltc: string | null;
  xmr: string | null;
  wow: string | null;
  grin: string | null;
}

export interface SmirkSignature {
  asset: SmirkAsset;
  signature: string;
  publicKey: string;
}

export interface SmirkSignResult {
  message: string;
  signatures: SmirkSignature[];
}

export interface SmirkPaymentRequest {
  asset: 'btc' | 'ltc' | 'xmr' | 'wow';
  /** Atomic-units string. Float would be a foot-gun across decimals
   *  ranging from 8 (BTC) to 12 (WOW). */
  amount: string;
  address: string;
  memo?: string;
}

export interface SmirkPaymentResult {
  success: boolean;
  txid?: string;
  error?: string;
}

export interface SmirkClaimResult {
  success: boolean;
  txid?: string;
  error?: string;
}

/** The backend this wallet is pointed at. A page (e.g. a checkout) reads it so
 *  it talks to the user's CHOSEN backend instead of hardcoding one. */
export interface SmirkBackend {
  /** Absolute API base URL, e.g. `https://api.smirk.cash/api/v1`. */
  url: string;
}

/** An unsigned Nostr event (NIP-01) the page asks the wallet to sign. The
 *  wallet stamps `created_at`/`pubkey`, computes the id, and schnorr-signs it.
 *  General-purpose: covers NIP-98 auth (kind 27235), notes (kind 1), etc. */
export interface SmirkNostrUnsignedEvent {
  kind: number;
  content: string;
  tags: string[][];
  /** Optional; the wallet stamps `now` when omitted. */
  created_at?: number;
}

/** A signed Nostr event (NIP-01). */
export interface SmirkNostrSignedEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  sig: string;
}

/** The app-scoped e2ee public key a dapp seals to (libsodium `crypto_box_seal`).
 *  Deterministic + seed-derived + origin-bound; the wallet holds the secret half
 *  and only ever opens boxes, never exports the private key. */
export interface SmirkAppEncryptionKey {
  /** X25519 public key, 32-byte hex. Seal to this with `crypto_box_seal`. */
  publicKey: string;
  /** Envelope scheme identifier, e.g. `x25519-sealedbox`. Pins the on-the-wire
   *  format so a future scheme bump is detectable by the dapp. */
  scheme: string;
}

// ============================================================================
// Method dispatch table — single source of truth for what the page-side
// surface and wallet-side handler agree on.
// ============================================================================

export type SmirkMethodMap = {
  connect: {
    params: { assets?: SmirkAsset[] };
    result: SmirkPublicKeys;
  };
  disconnect: {
    params: Record<string, never>;
    result: { ok: true };
  };
  isConnected: {
    params: Record<string, never>;
    result: boolean;
  };
  getPublicKeys: {
    params: Record<string, never>;
    result: SmirkPublicKeys | null;
  };
  getAddresses: {
    params: Record<string, never>;
    result: SmirkAddresses | null;
  };
  signMessage: {
    params: { message: string };
    result: SmirkSignResult;
  };
  requestPayment: {
    params: SmirkPaymentRequest;
    result: SmirkPaymentResult;
  };
  claimPublicTip: {
    params: { tipId: string; fragmentKey: string };
    result: SmirkClaimResult;
  };
  getBackend: {
    params: Record<string, never>;
    result: SmirkBackend;
  };
  getNostrPublicKey: {
    params: Record<string, never>;
    /** x-only hex pubkey; `null` if the origin lacks/declines the nostr scope. */
    result: string | null;
  };
  signNostrEvent: {
    params: { event: SmirkNostrUnsignedEvent };
    result: SmirkNostrSignedEvent;
  };
  getAppEncryptionKey: {
    /** `context` sub-scopes the key WITHIN the origin (e.g. `sso`, `notes`), so
     *  one site can hold several unlinkable keys. Omitted = the origin's default
     *  key. Never a cross-origin string — the handler binds to the verified origin. */
    params: { context?: string };
    /** The x25519 sealing key; `null` if the origin lacks/declines the e2ee scope. */
    result: SmirkAppEncryptionKey | null;
  };
  appSealOpen: {
    /** `sealed`: base64 libsodium `crypto_box_seal` envelope addressed to the
     *  app key for `context`. Requires the e2ee scope (granted via a prior
     *  `getAppEncryptionKey`). */
    params: { sealed: string; context?: string };
    /** `plaintext`: base64 of the opened bytes (the dapp decodes; may be binary). */
    result: { plaintext: string };
  };
  /** NIP-07 encrypt: the wallet encrypts `plaintext` to `peer` (x-only hex) under
   *  the user's Nostr identity. Requires the Nostr scope; runs silently once
   *  granted (low-tier, like reading a DM). Default scheme is NIP-44. */
  nostrEncrypt: {
    params: { peer: string; plaintext: string; scheme?: SmirkNostrCryptScheme };
    result: string;
  };
  /** NIP-07 decrypt: inverse of `nostrEncrypt`. */
  nostrDecrypt: {
    params: { ciphertext: string; peer: string; scheme?: SmirkNostrCryptScheme };
    result: string;
  };
};

/** NIP-07 DM encryption scheme. NIP-44 (v2) is the default + interop baseline;
 *  NIP-04 is legacy support for older dapps. */
export type SmirkNostrCryptScheme = 'nip44' | 'nip04';

export type SmirkMethod = keyof SmirkMethodMap;

// ============================================================================
// Wire envelope. Direction-tagged so a transport that loops back its
// own messages (e.g., window.postMessage with `event.source === window`)
// can filter cleanly.
// ============================================================================

export interface SmirkWireRequest<M extends SmirkMethod = SmirkMethod> {
  /** Discriminator for the message direction. */
  type: 'SMIRK_REQUEST';
  /** Protocol version. Wallet-side rejects on mismatch with a clear
   *  error rather than guessing. */
  v: typeof PROTOCOL_VERSION;
  /** Monotonic per-page-load request id. */
  id: number;
  method: M;
  params: SmirkMethodMap[M]['params'];
}

export interface SmirkWireResponse<M extends SmirkMethod = SmirkMethod> {
  type: 'SMIRK_RESPONSE';
  v: typeof PROTOCOL_VERSION;
  id: number;
  /** Result-or-error union. `error` carries a human-readable
   *  message + a stable machine code for programmatic handling. */
  result?: SmirkMethodMap[M]['result'];
  error?: {
    code: SmirkErrorCode;
    message: string;
  };
}

/** Stable error codes — pages can branch on these. */
export type SmirkErrorCode =
  | 'USER_REJECTED' //   user denied the approval prompt
  | 'NOT_CONNECTED' //   no permission for this origin
  | 'NOT_AUTHORIZED' //  permission exists but doesn't cover the requested asset
  | 'LOCKED' //          wallet locked, user must unlock first
  | 'INVALID_PARAMS' //  request shape was wrong
  | 'UNSUPPORTED' //     method not implemented on this version
  | 'PROTOCOL_MISMATCH' //  wallet ↔ page protocol version mismatch
  | 'TIMEOUT' //         no response within the allotted window
  | 'INTERNAL'; //       wallet-side exception; check console

/** Error class thrown by the page-api surface when the wallet returns
 *  an error envelope. Wraps both fields so page code can either show
 *  `err.message` or branch on `err.code`. */
export class SmirkRpcError extends Error {
  constructor(
    public readonly code: SmirkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SmirkRpcError';
  }
}
