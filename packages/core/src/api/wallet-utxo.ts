/**
 * BTC/LTC wallet API methods (UTXO-based, backed by Electrum on the server).
 */

import { ApiClient, ApiResponse } from './client';

export interface WalletUtxoMethods {
  getUtxoBalance(
    asset: 'btc' | 'ltc',
    address: string,
  ): Promise<
    ApiResponse<{
      asset: string;
      address: string;
      confirmed: number;
      unconfirmed: number;
      total: number;
    }>
  >;

  getUtxos(
    asset: 'btc' | 'ltc',
    address: string,
  ): Promise<
    ApiResponse<{
      asset: string;
      address: string;
      utxos: Array<{
        txid: string;
        vout: number;
        value: number;
        height: number;
      }>;
    }>
  >;

  broadcastTx(
    asset: 'btc' | 'ltc',
    txHex: string,
  ): Promise<ApiResponse<{ asset: string; txid: string }>>;

  getHistory(
    asset: 'btc' | 'ltc',
    address: string,
  ): Promise<
    ApiResponse<{
      asset: string;
      address: string;
      transactions: Array<{
        txid: string;
        height: number;
        fee?: number;
        total_received?: number;
        total_sent?: number;
      }>;
    }>
  >;

  estimateFee(asset: 'btc' | 'ltc'): Promise<
    ApiResponse<{
      asset: string;
      fast: number | null;
      normal: number | null;
      slow: number | null;
    }>
  >;
}

// UTXO route paths per backend dialect. `flat` = legacy backend; `namespaced`
// = smirk-backend-core. Note `fees`→`fee` (plural→singular) on the namespaced
// side — not a clean prefix swap, hence the explicit table.
const UTXO_PATHS = {
  flat: {
    balance: '/wallet/balance',
    utxos: '/wallet/utxos',
    broadcast: '/wallet/broadcast',
    history: '/wallet/history',
    fee: '/wallet/fees',
  },
  namespaced: {
    balance: '/wallet/utxo/balance',
    utxos: '/wallet/utxo/utxos',
    broadcast: '/wallet/utxo/broadcast',
    history: '/wallet/utxo/history',
    fee: '/wallet/utxo/fee',
  },
} as const;

const utxoPath = (client: ApiClient, key: keyof (typeof UTXO_PATHS)['flat']): string =>
  UTXO_PATHS[client.getWalletApiStyle()][key];

export function createWalletUtxoMethods(client: ApiClient): WalletUtxoMethods {
  return {
    async getUtxoBalance(asset, address) {
      return client.request(utxoPath(client, 'balance'), {
        method: 'POST',
        body: JSON.stringify({ asset, address }),
      });
    },

    async getUtxos(asset, address) {
      return client.request(utxoPath(client, 'utxos'), {
        method: 'POST',
        body: JSON.stringify({ asset, address }),
      });
    },

    async broadcastTx(asset, txHex) {
      // POST — no retry. Broadcasting twice could double-spend in theory
      // (the server dedupes by txid, but better safe).
      return client.request(utxoPath(client, 'broadcast'), {
        method: 'POST',
        body: JSON.stringify({ asset, tx_hex: txHex }),
      });
    },

    async getHistory(asset, address) {
      return client.request(utxoPath(client, 'history'), {
        method: 'POST',
        body: JSON.stringify({ asset, address }),
      });
    },

    async estimateFee(asset) {
      const path = utxoPath(client, 'fee');
      if (client.getWalletApiStyle() !== 'namespaced') {
        // Legacy flat backend: POST {asset} -> {asset, fast, normal, slow}.
        return client.request(path, {
          method: 'POST',
          body: JSON.stringify({ asset }),
        });
      }
      // smirk-backend-core: POST {asset, blocks} -> {asset, sat_per_vb}, one rate
      // per confirmation target. The route moved to /wallet/utxo/fee but the
      // payload+response contract differs from flat, so it must be translated per
      // dialect (the previous code sent the flat body here and 422'd, permanently
      // disabling BTC/LTC send + tip funding against namespaced backends). Fetch
      // the fast/normal/slow targets in parallel and map into the {fast, normal,
      // slow} shape every caller expects.
      const tierRequest = (blocks: number) =>
        client.request<{ asset: string; sat_per_vb: number | null }>(path, {
          method: 'POST',
          body: JSON.stringify({ asset, blocks }),
        });
      // Explicit 3-tuple (not .map) so the destructure is typed, not `| undefined`.
      const [fast, normal, slow] = await Promise.all([
        tierRequest(1), // fast
        tierRequest(3), // normal
        tierRequest(6), // slow
      ]);
      // The normal tier is load-bearing (most callers read .normal). If it failed
      // outright, surface the error envelope so callers can fall back cleanly.
      if (normal.error || !normal.data) {
        return {
          error: normal.error ?? 'fee estimate unavailable',
          ...(normal.status !== undefined ? { status: normal.status } : {}),
          ...(normal.code !== undefined ? { code: normal.code } : {}),
        };
      }
      const rateOf = (r: ApiResponse<{ asset: string; sat_per_vb: number | null }>): number | null =>
        r.data && typeof r.data.sat_per_vb === 'number' ? r.data.sat_per_vb : null;
      const normalRate = rateOf(normal);
      return {
        data: {
          asset,
          fast: rateOf(fast) ?? normalRate,
          normal: normalRate,
          slow: rateOf(slow) ?? normalRate,
        },
        status: 200,
      };
    },
  };
}
