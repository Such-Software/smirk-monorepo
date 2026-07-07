/**
 * Grin wallet API methods — slatepack relay and output management.
 *
 * The slatepack relay is a backend convenience: instead of forcing users
 * to copy/paste slatepacks out-of-band (Telegram, email, ...), the sender
 * posts a slatepack to `/wallet/grin/relay/create` and the recipient pulls
 * it from `GET /wallet/grin/relay/pending`. The relay never sees plaintext
 * slate contents — slatepacks are encrypted to the recipient's slatepack
 * address. The backend just routes ciphertext.
 *
 * The v3 backend keys every relay entry on its `slate_id` (a UUID) and
 * identifies the caller from the bearer token — there is no separate row
 * `id` and no `user_id`/`relay_id` in the request bodies. This adapter keeps
 * the five method signatures stable for existing callers by (a) synthesizing
 * the legacy per-item `id` from `slate_id` (so `relayId` round-trips back as
 * the `slate_id` the v3 respond/cancel endpoints want), and (b) splitting the
 * flat `{ relays }` response into the caller's two buckets by lifecycle
 * status: `pending_recipient` → the caller must respond (`pending_to_sign`),
 * `pending_sender` → the recipient responded, caller finalizes
 * (`pending_to_finalize`).
 *
 * Output management mirrors `grin-wallet`'s output store (UnspentOut,
 * Locked, Spent) so the wallet shell can render correct balances.
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

export interface GrinMethods {
  // ----- Slatepack relay -----
  createGrinRelay(params: {
    senderUserId: string;
    slatepack: string;
    slateId: string;
    amount: number;
    recipientUserId?: string;
    recipientAddress?: string;
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

  // ----- User balance and history -----
  getGrinUserBalance(userId: string): Promise<
    ApiResponse<{ confirmed: number; locked: number; pending: number; total: number }>
  >;

  getGrinUserHistory(userId: string): Promise<
    ApiResponse<{
      transactions: Array<{
        id: string;
        slate_id: string;
        amount: number;
        fee: number;
        direction: 'send' | 'receive';
        status: 'pending' | 'signed' | 'finalized' | 'confirmed' | 'cancelled';
        counterparty_user_id: string | null;
        created_at: string;
        kernel_excess: string | null;
      }>;
    }>
  >;

  // ----- Output management -----
  getGrinOutputs(userId: string): Promise<
    ApiResponse<{
      outputs: Array<{
        id: string;
        key_id: string;
        n_child: number;
        amount: number;
        commitment: string;
        is_coinbase: boolean;
        block_height: number | null;
        status: 'unconfirmed' | 'unspent' | 'locked' | 'spent';
      }>;
      next_child_index: number;
    }>
  >;

  /**
   * Page the node's UNSPENT output set WITH rangeproofs, for seed-only
   * recovery (the client rewinds each proof with its view key). Bounded
   * from the wallet birthday (`startHeight` is mapped to a start MMR index
   * server-side) and paginated by `startIndex` (pass `lastRetrievedIndex +
   * 1` from the previous page; stop when `lastRetrievedIndex` reaches
   * `highestIndex`). JWT-required. Response is raw snake_case.
   */
  scanGrinUnspentOutputs(params: {
    startIndex?: number | undefined;
    startHeight?: number | undefined;
    max?: number | undefined;
  }): Promise<
    ApiResponse<{
      highest_index: number;
      last_retrieved_index: number;
      outputs: Array<{
        commit: string;
        block_height: number | null;
        mmr_index: number;
        proof: string | null;
      }>;
    }>
  >;

  recordGrinOutput(params: {
    userId: string;
    keyId: string;
    nChild: number;
    amount: number;
    commitment: string;
    /** Originating slate UUID. Omit for recovered outputs (no slate); the
     *  backend stores NULL. Sending "" yields a 400 (invalid UUID). */
    txSlateId?: string;
    blockHeight?: number;
    lockHeight?: number;
  }): Promise<ApiResponse<{ id: string }>>;

  lockGrinOutputs(params: {
    userId: string;
    outputIds: string[];
    txSlateId: string;
  }): Promise<ApiResponse<void>>;

  unlockGrinOutputs(params: {
    userId: string;
    txSlateId: string;
  }): Promise<ApiResponse<void>>;

  spendGrinOutputs(params: {
    userId: string;
    txSlateId: string;
  }): Promise<ApiResponse<void>>;

  // ----- Transaction management -----
  recordGrinTransaction(params: {
    userId: string;
    slateId: string;
    amount: number;
    fee: number;
    direction: 'send' | 'receive';
    counterpartyAddress?: string;
  }): Promise<ApiResponse<{ id: string }>>;

  updateGrinTransaction(params: {
    userId: string;
    slateId: string;
    status: 'pending' | 'signed' | 'finalized' | 'confirmed' | 'cancelled';
    kernelExcess?: string;
  }): Promise<ApiResponse<void>>;

  broadcastGrinTransaction(params: {
    userId: string;
    slateId: string;
    tx: object;
    /** Optional change-output details. v0.3+ clients pass this so the
     *  backend atomically records the change row alongside the
     *  broadcast — eliminating the orphan-on-cancel window where a
     *  pre-broadcast record left an `unconfirmed` row stranded if the
     *  user cancelled. v0.2.4 clients don't send this (they call
     *  `recordGrinOutput` separately pre-broadcast); backend's INSERT
     *  uses ON CONFLICT (commitment) DO NOTHING so both paths
     *  coexist. */
    changeOutput?: {
      keyId: string;
      nChild: number;
      amount: number;
      commitment: string;
    };
  }): Promise<ApiResponse<{ success: boolean }>>;

  // ----- Address registration -----
  /**
   * Register (or update) the user's bech32 slatepack address in the
   * backend `wallets` table. The Grin relay's address-match query
   * joins on `wallets.address` for asset='grin'; without this call
   * the table stays empty for Grin (the equivalent of XMR/WOW's
   * `registerLws`). Call on every bootstrap — idempotent UPSERT.
   */
  registerGrinAddress(
    address: string,
  ): Promise<ApiResponse<{ address: string }>>;
}

export function createGrinMethods(client: ApiClient): GrinMethods {
  return {
    // ----- Slatepack relay (v3: /wallet/grin/relay/*, keyed on slate_id,
    // caller identified by the bearer token) -----
    async createGrinRelay(params) {
      // v3 requires a REGISTERED recipient (recipient_user_id); it does not
      // accept a bare slatepack address. Address-only relay needs a backend
      // address→userId lookup that v3 doesn't expose yet, so callers must
      // resolve the recipient's userId first.
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

    // ----- User balance and history -----
    async getGrinUserBalance(userId) {
      return client.retryableRequest(`/wallet/grin/user/${userId}/balance`, { method: 'GET' });
    },

    async getGrinUserHistory(userId) {
      return client.retryableRequest(`/wallet/grin/user/${userId}/history`, { method: 'GET' });
    },

    // ----- Output management -----
    async getGrinOutputs(userId) {
      return client.retryableRequest(`/wallet/grin/user/${userId}/outputs`, { method: 'GET' });
    },

    async scanGrinUnspentOutputs(params) {
      // Idempotent read (paging the UTXO set) → retryable.
      return client.retryableRequest('/wallet/grin/unspent-outputs', {
        method: 'POST',
        body: JSON.stringify({
          start_index: params.startIndex,
          start_height: params.startHeight,
          max: params.max,
        }),
      });
    },

    async recordGrinOutput(params) {
      return client.request('/wallet/grin/outputs', {
        method: 'POST',
        body: JSON.stringify({
          user_id: params.userId,
          key_id: params.keyId,
          n_child: params.nChild,
          amount: params.amount,
          commitment: params.commitment,
          // Omit (→ JSON drops undefined → backend None → NULL) when empty;
          // recovered outputs have no slate and "" is an invalid UUID (400).
          tx_slate_id: params.txSlateId || undefined,
          block_height: params.blockHeight,
          lock_height: params.lockHeight,
        }),
      });
    },

    async lockGrinOutputs(params) {
      return client.request('/wallet/grin/outputs/lock', {
        method: 'POST',
        body: JSON.stringify({
          user_id: params.userId,
          output_ids: params.outputIds,
          tx_slate_id: params.txSlateId,
        }),
      });
    },

    async unlockGrinOutputs(params) {
      return client.retryableRequest('/wallet/grin/outputs/unlock', {
        method: 'POST',
        body: JSON.stringify({
          user_id: params.userId,
          tx_slate_id: params.txSlateId,
        }),
      });
    },

    async spendGrinOutputs(params) {
      return client.retryableRequest('/wallet/grin/outputs/spend', {
        method: 'POST',
        body: JSON.stringify({
          user_id: params.userId,
          tx_slate_id: params.txSlateId,
        }),
      });
    },

    // ----- Transaction management -----
    async recordGrinTransaction(params) {
      return client.request('/wallet/grin/transactions', {
        method: 'POST',
        body: JSON.stringify({
          user_id: params.userId,
          slate_id: params.slateId,
          amount: params.amount,
          fee: params.fee,
          direction: params.direction,
          counterparty_address: params.counterpartyAddress,
        }),
      });
    },

    async updateGrinTransaction(params) {
      return client.request('/wallet/grin/transactions/update', {
        method: 'POST',
        body: JSON.stringify({
          user_id: params.userId,
          slate_id: params.slateId,
          status: params.status,
          kernel_excess: params.kernelExcess,
        }),
      });
    },

    async broadcastGrinTransaction(params) {
      return client.request('/wallet/grin/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          user_id: params.userId,
          slate_id: params.slateId,
          tx: params.tx,
          ...(params.changeOutput
            ? {
                change_output: {
                  key_id: params.changeOutput.keyId,
                  n_child: params.changeOutput.nChild,
                  amount: params.changeOutput.amount,
                  commitment: params.changeOutput.commitment,
                },
              }
            : {}),
        }),
      });
    },

    async registerGrinAddress(address) {
      return client.request('/wallet/grin/address/register', {
        method: 'POST',
        body: JSON.stringify({ address }),
      });
    },
  };
}
