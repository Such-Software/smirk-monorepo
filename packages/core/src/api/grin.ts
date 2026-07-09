/**
 * Grin wallet API methods — scan (balance + spendable UTXOs), broadcast,
 * address→user discovery, and the slatepack relay mailbox.
 *
 * Grin on the v3 backend is NON-CUSTODIAL and nearly stateless: there is NO
 * server-side output store, balance endpoint, history, or output
 * lock/spend/record lifecycle. The client owns output state; the backend only:
 *
 *   - `POST /wallet/grin/scan` — rewinds the UTXO set with the wallet's
 *     `rewind_hash` (a view-only credential) and returns the matching outputs.
 *     Stores nothing. This is the SOURCE OF TRUTH for balance + spendable inputs.
 *   - `GET  /wallet/grin/height` — chain tip (for maturity math).
 *   - `POST /wallet/grin/broadcast {tx}` — relays a finalized tx to the node.
 *   - `GET  /wallet/grin/address/{addr}/user` — resolve a bech32 grin address to
 *     its registered owner (user_id + npub) for send routing.
 *
 * The slatepack relay (`/wallet/grin/relay/*`) is a same-instance convenience
 * mailbox: instead of copy/pasting slatepacks out-of-band, the sender posts to
 * `relay/create` and the recipient pulls from `relay/pending`. The relay never
 * sees plaintext — slatepacks are encrypted to the recipient's slatepack
 * address. v3 keys every entry on its `slate_id` and identifies the caller from
 * the bearer token.
 *
 * The custodial surface (getGrinUserBalance / getGrinOutputs / record / lock /
 * unlock / spend / recordGrinTransaction / updateGrinTransaction / scanUnspent /
 * registerGrinAddress) was deleted — those endpoints 404 on v3. Balance +
 * recovery now come from `scan`; address registration moved to `POST /keys`.
 */

import { ApiClient, ApiResponse } from './client';

/** A relay entry as the v3 backend returns it (keyed on `slate_id`, no row id).
 *  Internal to this adapter — callers see the mapped legacy shape. */
interface GrinRelayEntryV3 {
  slate_id: string;
  sender_user_id: string;
  recipient_user_id: string | null;
  /** The sender's armored slatepack (what the recipient responds to). */
  slatepack_content: string;
  /** The recipient's response slatepack, once provided. */
  response_slatepack: string | null;
  amount_nanogrin: number;
  status:
    | 'pending_recipient'
    | 'pending_sender'
    | 'finalized'
    | 'expired'
    | 'cancelled';
  created_at: string;
  expires_at: string;
  finalized_at: string | null;
  tx_hash: string | null;
}

/** A single output from `POST /wallet/grin/scan` (raw snake_case). */
export interface GrinScanOutputWire {
  commit: string;
  value: number;
  height: number;
  mmr_index: number;
  is_coinbase: boolean;
  lock_height: number;
  /** Recovered derivation key id; populated only on the grin-lws path (the
   *  on-demand grin-wallet fallback leaves these null). Its presence lets the
   *  client spend directly, without the client-side identify search. */
  key_id?: string | null;
  n_child?: number | null;
  spendable?: boolean | null;
}

export interface GrinScanResponse {
  outputs: GrinScanOutputWire[];
  total_balance: number;
  last_pmmr_index: number;
  /** grin-lws sync state; null on the grin-wallet fallback path. The backend
   *  already gates on these server-side, so the client keeps them for
   *  diagnostics only. */
  scanned_height?: number | null;
  blockchain_height?: number | null;
}

export interface GrinMethods {
  // ----- Scan (balance + spendable UTXOs; source of truth) -----
  /**
   * Rewind the node's UTXO set with the wallet's `rewind_hash` (view-only) and
   * return this wallet's currently-unspent outputs. Stores nothing server-side.
   * Idempotent read → retryable. `rewind_hash` is a 64-hex view credential
   * derived from the public root key; it can read but never spend.
   */
  scanGrin(params: {
    rewindHash: string;
    startHeight?: number | undefined;
    restorePowNonce?: number | undefined;
  }): Promise<ApiResponse<GrinScanResponse>>;

  // ----- Address → user discovery (send routing) -----
  /**
   * Resolve a bech32 grin slatepack address to its registered owner, so a
   * bare-address send can route to the owner's npub (Nostr) or user_id
   * (backend relay) instead of only manual clipboard handoff.
   */
  getGrinAddressUser(address: string): Promise<
    ApiResponse<{ registered: boolean; user_id?: string | null; npub?: string | null }>
  >;

  // ----- Broadcast -----
  /** Relay a finalized tx to the node. Backend reads only `{ tx }`. */
  broadcastGrinTransaction(params: {
    tx: object;
  }): Promise<ApiResponse<{ success: boolean }>>;

  // ----- Slatepack relay -----
  createGrinRelay(params: {
    senderUserId: string;
    slatepack: string;
    slateId: string;
    amount: number;
    /** REQUIRED: v3 relay routes by recipient user_id (no address→user lookup). */
    recipientUserId: string;
  }): Promise<ApiResponse<{ id: string; expires_at: string }>>;

  getGrinPendingSlatepacks(userId: string): Promise<
    ApiResponse<{
      pending_to_sign: Array<{
        id: string;
        slate_id: string;
        sender_user_id: string;
        amount: number;
        slatepack: string;
        created_at: string;
        expires_at: string;
      }>;
      pending_to_finalize: Array<{
        id: string;
        slate_id: string;
        sender_user_id: string;
        amount: number;
        slatepack: string;
        created_at: string;
        expires_at: string;
      }>;
    }>
  >;

  signGrinSlatepack(params: {
    relayId: string;
    userId: string;
    signedSlatepack: string;
  }): Promise<ApiResponse<{ success: boolean }>>;

  finalizeGrinSlatepack(params: {
    relayId: string;
    userId: string;
    finalizedSlatepack: string;
  }): Promise<ApiResponse<{ broadcast: boolean }>>;

  cancelGrinSlatepack(params: {
    relayId: string;
    userId: string;
  }): Promise<ApiResponse<{ success: boolean }>>;
}

export function createGrinMethods(client: ApiClient): GrinMethods {
  return {
    // ----- Scan -----
    async scanGrin(params) {
      return client.retryableRequest<GrinScanResponse>('/wallet/grin/scan', {
        method: 'POST',
        body: JSON.stringify({
          rewind_hash: params.rewindHash,
          ...(params.startHeight !== undefined ? { start_height: params.startHeight } : {}),
          ...(params.restorePowNonce !== undefined
            ? { restore_pow_nonce: params.restorePowNonce }
            : {}),
        }),
      });
    },

    // ----- Address → user discovery -----
    async getGrinAddressUser(address) {
      return client.retryableRequest(
        `/wallet/grin/address/${encodeURIComponent(address)}/user`,
        { method: 'GET' },
      );
    },

    // ----- Broadcast (backend reads only { tx }) -----
    async broadcastGrinTransaction(params) {
      return client.request('/wallet/grin/broadcast', {
        method: 'POST',
        body: JSON.stringify({ tx: params.tx }),
      });
    },

    // ----- Slatepack relay (v3: /wallet/grin/relay/*, keyed on slate_id,
    // caller identified by the bearer token) -----
    async createGrinRelay(params) {
      const res = await client.request<GrinRelayEntryV3>('/wallet/grin/relay/create', {
        method: 'POST',
        body: JSON.stringify({
          recipient_user_id: params.recipientUserId,
          slate_id: params.slateId,
          slatepack: params.slatepack,
          amount_nanogrin: params.amount,
        }),
      });
      // Legacy callers read `.data.id`; v3 keys on slate_id. Map it through so
      // the value they round-trip back to respond/cancel is the slate_id.
      if (res.data) {
        return { ...res, data: { id: res.data.slate_id, expires_at: res.data.expires_at } };
      }
      const { error, status, code } = res;
      return {
        ...(error !== undefined ? { error } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(code !== undefined ? { code } : {}),
      };
    },

    async getGrinPendingSlatepacks(_userId) {
      // The `_userId` arg is retained for signature compat but unused — v3
      // identifies the recipient from the bearer token.
      const res = await client.retryableRequest<{ relays: GrinRelayEntryV3[] }>(
        '/wallet/grin/relay/pending',
        { method: 'GET' },
      );
      if (res.error || !res.data) {
        const { error, status, code } = res;
        return { ...(error !== undefined ? { error } : {}), ...(status !== undefined ? { status } : {}), ...(code !== undefined ? { code } : {}) };
      }
      const toItem = (e: GrinRelayEntryV3, slatepack: string) => ({
        id: e.slate_id, // v3 has no separate id; synthesize from slate_id
        slate_id: e.slate_id,
        sender_user_id: e.sender_user_id,
        amount: e.amount_nanogrin,
        slatepack,
        created_at: e.created_at,
        expires_at: e.expires_at,
      });
      const relays = res.data.relays ?? [];
      return {
        ...res,
        data: {
          // Caller is the RECIPIENT: the sender's slatepack awaits a response.
          pending_to_sign: relays
            .filter((r) => r.status === 'pending_recipient')
            .map((r) => toItem(r, r.slatepack_content)),
          // Caller is the SENDER: the recipient responded; finalize with it.
          pending_to_finalize: relays
            .filter((r) => r.status === 'pending_sender')
            .map((r) => toItem(r, r.response_slatepack ?? '')),
        },
      };
    },

    async signGrinSlatepack(params) {
      // v3 "respond": the recipient attaches their response slatepack. relayId
      // is the slate_id (synthesized above).
      return client.request('/wallet/grin/relay/respond', {
        method: 'POST',
        body: JSON.stringify({
          slate_id: params.relayId,
          response_slatepack: params.signedSlatepack,
        }),
      });
    },

    async finalizeGrinSlatepack(params) {
      return client.request('/wallet/grin/relay/finalize', {
        method: 'POST',
        body: JSON.stringify({
          slate_id: params.relayId,
          tx_hash: params.finalizedSlatepack,
        }),
      });
    },

    async cancelGrinSlatepack(params) {
      return client.retryableRequest('/wallet/grin/relay/cancel', {
        method: 'POST',
        body: JSON.stringify({ slate_id: params.relayId }),
      });
    },
  };
}
