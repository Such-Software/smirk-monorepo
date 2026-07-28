/**
 * BTC/LTC wallet API methods (UTXO-based, backed by Electrum on the server).
 */

import { ApiClient, ApiResponse } from './client';

/** An owned address paired with its client-side BIP84 master path (G9). */
export interface UtxoAddressRef {
  address: string;
  masterPath: string;
}

/** A UTXO tagged with the address (and client-side path) that owns it. */
export interface TaggedUtxo {
  address: string;
  masterPath: string;
  txid: string;
  vout: number;
  value: number;
  height: number;
}

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

  // --- Multi-address (FEATURE_UTXO_MULTI_ADDRESS; routes 404 when backend flag off) ---

  /** Aggregate balance across several owned addresses. */
  getUtxoBalanceMulti(
    asset: 'btc' | 'ltc',
    addresses: string[],
  ): Promise<
    ApiResponse<{
      asset: string;
      confirmed: number;
      unconfirmed: number;
      total: number;
    }>
  >;

  /**
   * UTXOs across several owned addresses, each tagged with its owning address
   * and (client-re-attached) master path. `refs` carries both the address to
   * query and the master path; only the addresses are sent to the server, and
   * every returned UTXO's `masterPath` is filled in locally from `refs` — the
   * path is never taken from the server response (money gate G9).
   */
  getUtxosMulti(
    asset: 'btc' | 'ltc',
    refs: UtxoAddressRef[],
  ): Promise<ApiResponse<{ asset: string; utxos: TaggedUtxo[] }>>;

  /** Aggregate history across several owned addresses. */
  getHistoryMulti(
    asset: 'btc' | 'ltc',
    addresses: string[],
  ): Promise<
    ApiResponse<{
      asset: string;
      transactions: Array<{
        txid: string;
        height: number;
        fee?: number;
        total_received?: number;
        total_sent?: number;
      }>;
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

/**
 * Multi-address route table. Only the namespaced (smirk-backend-core) dialect
 * exposes these — they map to the FEATURE_UTXO_MULTI_ADDRESS routes and 404
 * when that backend flag is off. The flat/legacy backend has no equivalent,
 * so the client flag (ENABLE_BTCLTC_FRESH_ADDRS) should only be turned on
 * against a namespaced backend that advertises the feature.
 *
 * Both "too many addresses" and "route not mounted" are handled below rather
 * than surfaced: an oversized ask is chunked, and a 404 falls back to the
 * per-address routes that exist on every dialect.
 */
const UTXO_MULTI_PATHS = {
  balance: '/wallet/utxo/balance_multi',
  utxos: '/wallet/utxo/utxos_multi',
  history: '/wallet/utxo/history_multi',
} as const;

/**
 * Server-side cap on one batch request: `MAX_MULTI_ADDRESSES` in
 * smirk-backend-core (`src/api/wallet/btc_ltc.rs`).
 *
 * The backend REJECTS an oversized list with a 400 rather than truncating it
 * (deliberately: a silently narrowed query would hide funds). The scan set
 * grows past this cap quickly once the gap window slides: a receive window of
 * `0..usedHigh + 20` plus a change window of the same shape is well over 32
 * addresses after a handful of change-producing sends. Every `*_multi` call
 * below therefore splits its address list into batches of at most this many and
 * merges the results, so the cap is a transport detail and never a ceiling on
 * what the wallet can see or spend.
 *
 * ONE constant, exported, so the client's batching and any test that asserts
 * against the backend's limit cannot drift apart.
 */
export const UTXO_MULTI_MAX_ADDRESSES = 32;

/** How many per-address fallback requests to keep in flight at once. */
const FALLBACK_CONCURRENCY = 8;

/** Split `items` into consecutive batches of at most `size`. */
function batched<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * De-duplicate by key, keeping first occurrence. Load-bearing for balance: the
 * server sums per address, so the same address twice in one batch would be
 * counted twice and over-report the balance.
 */
function dedupeBy<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/** True when the response says the route itself is not mounted (backend feature off). */
function routeMissing(r: ApiResponse<unknown>): boolean {
  return r.status === 404;
}

/** Re-shape an errored envelope, preserving status/code, under a new data type. */
function errorEnvelope<T>(r: ApiResponse<unknown>, fallbackMessage: string): ApiResponse<T> {
  return {
    error: r.error ?? fallbackMessage,
    ...(r.status !== undefined ? { status: r.status } : {}),
    ...(r.code !== undefined ? { code: r.code } : {}),
  };
}

/** Run `fn` over `items` with bounded concurrency, preserving input order. */
async function mapLimited<A, B>(
  items: readonly A[],
  limit: number,
  fn: (item: A) => Promise<B>,
): Promise<B[]> {
  const out: B[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

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

    // Every `*_multi` method below follows the same three rules:
    //   1. De-duplicate, then split into <= UTXO_MULTI_MAX_ADDRESSES batches and
    //      merge; the backend rejects an oversized list outright.
    //   2. A 404 on the batch route (backend feature off, or a legacy flat
    //      dialect that never had it) degrades to the per-address routes that
    //      exist everywhere, so a client-flag/backend-flag mismatch reads a
    //      correct balance and can still spend, instead of reading zero.
    //   3. ANY other per-batch failure fails the whole call. A partial merge
    //      would silently under-report the balance and hide spendable funds.

    async getUtxoBalanceMulti(asset, addresses) {
      const unique = dedupeBy(addresses, (a) => a);
      if (unique.length === 0) {
        return { data: { asset, confirmed: 0, unconfirmed: 0, total: 0 }, status: 200 };
      }
      type BalanceBody = { asset: string; confirmed: number; unconfirmed: number; total?: number };
      const results = await Promise.all(
        batched(unique, UTXO_MULTI_MAX_ADDRESSES).map((batch) =>
          client.request<BalanceBody>(UTXO_MULTI_PATHS.balance, {
            method: 'POST',
            body: JSON.stringify({ asset, addresses: batch }),
          }),
        ),
      );
      if (results.some(routeMissing)) {
        // Per-address fallback. Sums exactly the same address set, so the
        // number is the same one the batch route would have returned.
        const singles = await mapLimited(unique, FALLBACK_CONCURRENCY, (address) =>
          client.request<BalanceBody>(utxoPath(client, 'balance'), {
            method: 'POST',
            body: JSON.stringify({ asset, address }),
          }),
        );
        const bad = singles.find((r) => r.error || !r.data);
        if (bad) return errorEnvelope(bad, 'balance lookup failed');
        return sumBalances(asset, singles);
      }
      const bad = results.find((r) => r.error || !r.data);
      if (bad) return errorEnvelope(bad, 'balance_multi failed');
      return sumBalances(asset, results);
    },

    async getUtxosMulti(asset, refs) {
      // Only addresses cross the wire; the master path stays client-side and
      // is re-attached below so the signer's path is never server-influenced.
      const unique = dedupeBy(refs, (r) => r.address);
      if (unique.length === 0) return { data: { asset, utxos: [] }, status: 200 };
      const pathByAddress = new Map(unique.map((r) => [r.address, r.masterPath]));
      type UtxosBody = {
        asset: string;
        utxos: Array<{ address: string; txid: string; vout: number; value: number; height: number }>;
      };
      const results = await Promise.all(
        batched(unique, UTXO_MULTI_MAX_ADDRESSES).map((batch) =>
          client.request<UtxosBody>(UTXO_MULTI_PATHS.utxos, {
            method: 'POST',
            body: JSON.stringify({ asset, addresses: batch.map((r) => r.address) }),
          }),
        ),
      );

      if (results.some(routeMissing)) {
        // Per-address fallback: the single-address route returns untagged
        // UTXOs, so the owning address comes from the ref we asked with: the
        // same client-side source the batch path tags from (money gate G9).
        const singles = await mapLimited(unique, FALLBACK_CONCURRENCY, async (ref) => ({
          ref,
          resp: await client.request<{
            asset: string;
            address: string;
            utxos: Array<{ txid: string; vout: number; value: number; height: number }>;
          }>(utxoPath(client, 'utxos'), {
            method: 'POST',
            body: JSON.stringify({ asset, address: ref.address }),
          }),
        }));
        const bad = singles.find((s) => s.resp.error || !s.resp.data);
        if (bad) return errorEnvelope(bad.resp, 'utxo lookup failed');
        const tagged: TaggedUtxo[] = [];
        for (const { ref, resp } of singles) {
          for (const u of resp.data!.utxos) {
            tagged.push({
              address: ref.address,
              masterPath: ref.masterPath,
              txid: u.txid,
              vout: u.vout,
              value: u.value,
              height: u.height,
            });
          }
        }
        return { data: { asset, utxos: tagged }, status: 200 };
      }

      const bad = results.find((r) => r.error || !r.data);
      if (bad) return errorEnvelope(bad, 'utxos_multi failed');
      const tagged: TaggedUtxo[] = [];
      for (const r of results) {
        for (const u of r.data!.utxos) {
          const masterPath = pathByAddress.get(u.address);
          // A UTXO whose address we didn't ask about (server returned something
          // unexpected) has no client-side path — drop it rather than sign
          // against a guessed path. Money gate G9: no path, no spend.
          if (masterPath === undefined) continue;
          tagged.push({
            address: u.address,
            masterPath,
            txid: u.txid,
            vout: u.vout,
            value: u.value,
            height: u.height,
          });
        }
      }
      return { data: { asset, utxos: tagged }, status: 200 };
    },

    async getHistoryMulti(asset, addresses) {
      const unique = dedupeBy(addresses, (a) => a);
      if (unique.length === 0) return { data: { asset, transactions: [] }, status: 200 };
      type HistoryBody = {
        asset: string;
        transactions: Array<{
          txid: string;
          height: number;
          fee?: number;
          total_received?: number;
          total_sent?: number;
        }>;
      };
      const results = await Promise.all(
        batched(unique, UTXO_MULTI_MAX_ADDRESSES).map((batch) =>
          client.request<HistoryBody>(UTXO_MULTI_PATHS.history, {
            method: 'POST',
            body: JSON.stringify({ asset, addresses: batch }),
          }),
        ),
      );
      if (results.some(routeMissing)) {
        const singles = await mapLimited(unique, FALLBACK_CONCURRENCY, (address) =>
          client.request<HistoryBody>(utxoPath(client, 'history'), {
            method: 'POST',
            body: JSON.stringify({ asset, address }),
          }),
        );
        const bad = singles.find((r) => r.error || !r.data);
        if (bad) return errorEnvelope(bad, 'history lookup failed');
        return concatHistory(asset, singles);
      }
      const bad = results.find((r) => r.error || !r.data);
      if (bad) return errorEnvelope(bad, 'history_multi failed');
      return concatHistory(asset, results);
    },
  };
}

/** Sum a set of successful balance responses into one aggregate. */
function sumBalances(
  asset: string,
  parts: Array<ApiResponse<{ confirmed: number; unconfirmed: number }>>,
): ApiResponse<{ asset: string; confirmed: number; unconfirmed: number; total: number }> {
  let confirmed = 0;
  let unconfirmed = 0;
  for (const p of parts) {
    // `unconfirmed` is signed on the wire (a mempool spend reads negative), so
    // it is added, never clamped, or an in-flight send would read as a gain.
    confirmed += Number(p.data?.confirmed ?? 0);
    unconfirmed += Number(p.data?.unconfirmed ?? 0);
  }
  // `total` is computed here, not read off the wire: neither the batch nor the
  // per-address route sends one, so the previous pass-through left it undefined.
  return { data: { asset, confirmed, unconfirmed, total: confirmed + unconfirmed }, status: 200 };
}

/** Concatenate a set of successful history responses in request order. */
function concatHistory<
  E extends { txid: string; height: number; fee?: number; total_received?: number; total_sent?: number },
>(
  asset: string,
  parts: Array<ApiResponse<{ transactions: E[] }>>,
): ApiResponse<{ asset: string; transactions: E[] }> {
  const transactions: E[] = [];
  for (const p of parts) transactions.push(...(p.data?.transactions ?? []));
  return { data: { asset, transactions }, status: 200 };
}
