/**
 * Grin wallet API methods — slatepack relay and output management.
 *
 * The slatepack relay is a backend convenience: instead of forcing users
 * to copy/paste slatepacks out-of-band (Telegram, email, ...), the
 * sender posts a slatepack to `/grin/relay` and the recipient pulls it
 * from `/grin/relay/pending/:userId`. The relay never sees plaintext
 * slate contents — slatepacks are encrypted to the recipient's
 * slatepack address. The backend just routes ciphertext.
 *
 * Output management mirrors `grin-wallet`'s output store (UnspentOut,
 * Locked, Spent) so the wallet shell can render correct balances.
 */

import { ApiClient, ApiResponse } from './client';

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

  recordGrinOutput(params: {
    userId: string;
    keyId: string;
    nChild: number;
    amount: number;
    commitment: string;
    txSlateId: string;
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
  }): Promise<ApiResponse<{ success: boolean }>>;
}

export function createGrinMethods(client: ApiClient): GrinMethods {
  return {
    // ----- Slatepack relay -----
    async createGrinRelay(params) {
      return client.request('/grin/relay', {
        method: 'POST',
        body: JSON.stringify({
          sender_user_id: params.senderUserId,
          slatepack: params.slatepack,
          slate_id: params.slateId,
          amount: params.amount,
          recipient_user_id: params.recipientUserId,
          recipient_address: params.recipientAddress,
        }),
      });
    },

    async getGrinPendingSlatepacks(userId) {
      return client.retryableRequest(`/grin/relay/pending/${userId}`, { method: 'GET' });
    },

    async signGrinSlatepack(params) {
      return client.request('/grin/relay/sign', {
        method: 'POST',
        body: JSON.stringify({
          relay_id: params.relayId,
          user_id: params.userId,
          signed_slatepack: params.signedSlatepack,
        }),
      });
    },

    async finalizeGrinSlatepack(params) {
      return client.request('/grin/relay/finalize', {
        method: 'POST',
        body: JSON.stringify({
          relay_id: params.relayId,
          user_id: params.userId,
          finalized_slatepack: params.finalizedSlatepack,
        }),
      });
    },

    async cancelGrinSlatepack(params) {
      return client.retryableRequest('/grin/relay/cancel', {
        method: 'POST',
        body: JSON.stringify({
          relay_id: params.relayId,
          user_id: params.userId,
        }),
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

    async recordGrinOutput(params) {
      return client.request('/wallet/grin/outputs', {
        method: 'POST',
        body: JSON.stringify({
          user_id: params.userId,
          key_id: params.keyId,
          n_child: params.nChild,
          amount: params.amount,
          commitment: params.commitment,
          tx_slate_id: params.txSlateId,
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
        }),
      });
    },
  };
}
