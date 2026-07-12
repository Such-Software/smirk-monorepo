/**
 * XMR/WOW wallet API methods (via Light Wallet Server).
 */

import { ApiClient, ApiResponse } from './client';

export interface WalletLwsMethods {
  getLwsBalance(
    asset: 'xmr' | 'wow',
    address: string,
    viewKey: string,
  ): Promise<
    ApiResponse<{
      total_received: number;
      locked_balance: number;
      pending_balance: number;
      transaction_count: number;
      blockchain_height: number;
      start_height: number;
      scanned_height: number;
      spent_outputs: Array<{
        amount: number;
        key_image: string;
        tx_pub_key: string;
        out_index: number;
      }>;
    }>
  >;

  getUnspentOuts(
    asset: 'xmr' | 'wow',
    address: string,
    viewKey: string,
  ): Promise<
    ApiResponse<{
      outputs: Array<{
        amount: number;
        public_key: string;
        tx_pub_key: string;
        index: number;
        global_index: number;
        height: number;
        rct: string;
        spend_key_images: string[];
      }>;
      per_byte_fee: number;
      fee_mask: number;
    }>
  >;

  getRandomOuts(
    asset: 'xmr' | 'wow',
    count: number,
  ): Promise<
    ApiResponse<{
      outputs: Array<{
        global_index: number;
        public_key: string;
        rct: string;
      }>;
    }>
  >;

  submitLwsTx(
    asset: 'xmr' | 'wow',
    txHex: string,
    recipientAddress?: string,
    amount?: number,
    txHash?: string,
  ): Promise<ApiResponse<{ success: boolean; status: string }>>;

  getLwsHistory(
    asset: 'xmr' | 'wow',
    address: string,
    viewKey: string,
  ): Promise<
    ApiResponse<{
      asset: string;
      transactions: Array<{
        txid: string;
        height: number;
        timestamp: string;
        is_pending: boolean;
        total_received: number;
        spent_outputs: Array<{
          amount: number;
          key_image: string;
          tx_pub_key: string;
          out_index: number;
        }>;
        payment_id?: string;
      }>;
      scanned_height: number;
      blockchain_height: number;
    }>
  >;

  registerLws(
    userId: string,
    asset: 'xmr' | 'wow',
    address: string,
    viewKey: string,
    startHeight?: number,
  ): Promise<
    ApiResponse<{ success: boolean; message: string; start_height?: number }>
  >;

  deactivateLws(
    asset: 'xmr' | 'wow',
    address: string,
  ): Promise<ApiResponse<{ success: boolean; message: string }>>;
}

// LWS route paths per backend dialect. `flat` = legacy backend
// (~/src/smirk-backend); `namespaced` = smirk-backend-core (api.smirk.cash).
// balance / history / register share a path across both dialects; only the
// three SEND-path routes were renamed on the namespaced side (unspent ->
// unspent_outs, decoys -> random_outs, submit -> submit_tx). The client
// previously hardcoded the flat names for all dialects, so XMR/WOW balance
// reads worked against namespaced but every send / tip-fund / tip-sweep 404'd.
const LWS_PATHS = {
  flat: {
    unspent: '/wallet/lws/unspent',
    decoys: '/wallet/lws/decoys',
    submit: '/wallet/lws/submit',
  },
  namespaced: {
    unspent: '/wallet/lws/unspent_outs',
    decoys: '/wallet/lws/random_outs',
    submit: '/wallet/lws/submit_tx',
  },
} as const;

const lwsPath = (client: ApiClient, key: keyof (typeof LWS_PATHS)['flat']): string =>
  LWS_PATHS[client.getWalletApiStyle()][key];

export function createWalletLwsMethods(client: ApiClient): WalletLwsMethods {
  return {
    async getLwsBalance(asset, address, viewKey) {
      return client.request('/wallet/lws/balance', {
        method: 'POST',
        body: JSON.stringify({ asset, address, view_key: viewKey }),
      });
    },

    async getUnspentOuts(asset, address, viewKey) {
      return client.request(lwsPath(client, 'unspent'), {
        method: 'POST',
        body: JSON.stringify({ asset, address, view_key: viewKey }),
      });
    },

    async getRandomOuts(asset, count) {
      const path = lwsPath(client, 'decoys');
      if (client.getWalletApiStyle() !== 'namespaced') {
        // Legacy flat backend: {asset, count} -> flat {outputs}.
        return client.request(path, {
          method: 'POST',
          body: JSON.stringify({ asset, count }),
        });
      }
      // Namespaced random_outs speaks the monero-lws convention: request `mixins`
      // decoys per real output, one amount="0" bucket per output (RingCT). Callers
      // pass the FLAT total (mixins * numInputs), so recover numInputs from the
      // asset's ring size. The response is grouped by amount; flatten it back to
      // the flat {outputs} list every caller (send-handler, tip-claim, harness)
      // already expects, so no caller changes are needed. Each amount group maps
      // to one input's ring, which is exactly how the send-handler slices the pool.
      const mixins = (asset === 'wow' ? 22 : 16) - 1;
      const numInputs = Math.max(1, Math.round(count / mixins));
      const r = await client.request<{
        asset: string;
        amount_outs: Array<{
          amount: string;
          outputs: Array<{ global_index: number; public_key: string; rct: string }>;
        }>;
      }>(path, {
        method: 'POST',
        body: JSON.stringify({ asset, count: mixins, amounts: Array(numInputs).fill('0') }),
        // Decoy fetch can be slow when the backend's monero-lws is cold (it
        // re-pulls the full RCT output distribution at idle, ~15-42s). A generous
        // timeout lets a valid send complete instead of aborting at the 30s
        // default; under real load the distribution stays cached and this is fast.
        timeoutMs: 90_000,
      });
      if (r.error || !r.data) {
        return {
          error: r.error ?? 'random_outs failed',
          ...(r.status !== undefined ? { status: r.status } : {}),
          ...(r.code !== undefined ? { code: r.code } : {}),
        };
      }
      return {
        data: { outputs: r.data.amount_outs.flatMap((g) => g.outputs) },
        status: r.status ?? 200,
      };
    },

    async submitLwsTx(asset, txHex, recipientAddress, amount, txHash) {
      return client.request(lwsPath(client, 'submit'), {
        method: 'POST',
        body: JSON.stringify({
          asset,
          tx_hex: txHex,
          recipient_address: recipientAddress,
          amount,
          tx_hash: txHash,
        }),
      });
    },

    async getLwsHistory(asset, address, viewKey) {
      // Field-name normalization across dialects. Namespaced smirk-backend-core's
      // TxDto serializes the tx id as `hash` and the mempool flag as `mempool`;
      // the legacy flat backend used `txid` / `is_pending`. Map both to txid /
      // is_pending (defensive `??`) so consumers (e.g. asset-detail.tsx, which
      // reads t.txid / t.is_pending) stay dialect-blind and this method's declared
      // type never changes.
      const r = await client.request<{
        asset: string;
        transactions?: Array<{
          txid?: string;
          hash?: string;
          height: number;
          timestamp: string;
          is_pending?: boolean;
          mempool?: boolean;
          total_received: number;
          spent_outputs?: Array<{
            amount: number;
            key_image: string;
            tx_pub_key: string;
            out_index: number;
          }>;
          payment_id?: string;
        }>;
        scanned_height?: number;
        blockchain_height?: number;
      }>('/wallet/lws/history', {
        method: 'POST',
        body: JSON.stringify({ asset, address, view_key: viewKey }),
      });
      if (r.error || !r.data) {
        return {
          ...(r.error !== undefined ? { error: r.error } : {}),
          ...(r.status !== undefined ? { status: r.status } : {}),
          ...(r.code !== undefined ? { code: r.code } : {}),
        };
      }
      const d = r.data;
      return {
        data: {
          asset: d.asset,
          transactions: (d.transactions ?? []).map((t) => ({
            txid: t.txid ?? t.hash ?? '',
            height: t.height,
            timestamp: t.timestamp,
            is_pending: t.is_pending ?? t.mempool ?? false,
            total_received: t.total_received,
            spent_outputs: t.spent_outputs ?? [],
            ...(t.payment_id !== undefined ? { payment_id: t.payment_id } : {}),
          })),
          scanned_height: d.scanned_height ?? 0,
          blockchain_height: d.blockchain_height ?? 0,
        },
        ...(r.status !== undefined ? { status: r.status } : {}),
      };
    },

    async registerLws(userId, asset, address, viewKey, startHeight) {
      return client.request('/wallet/lws/register', {
        method: 'POST',
        body: JSON.stringify({
          user_id: userId,
          asset,
          address,
          view_key: viewKey,
          start_height: startHeight,
        }),
      });
    },

    async deactivateLws(asset, address) {
      // No /wallet/lws/deactivate route exists on namespaced smirk-backend-core
      // (only register/balance/history/unspent_outs/random_outs/submit_tx/height/
      // confirmations), so POSTing there is a guaranteed 404. This runs
      // best-effort after an XMR/WOW tip claim purely for server resource hygiene,
      // so on the namespaced dialect resolve as a success no-op and skip the doomed
      // call; the legacy flat backend does expose the route.
      if (client.getWalletApiStyle() === 'namespaced') {
        return {
          data: { success: true, message: 'deactivate not supported on this backend' },
        };
      }
      return client.request('/wallet/lws/deactivate', {
        method: 'POST',
        body: JSON.stringify({ asset, address }),
      });
    },
  };
}
