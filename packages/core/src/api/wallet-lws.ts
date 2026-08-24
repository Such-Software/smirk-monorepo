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
      total_received: string;
      locked_balance: string;
      pending_balance: string;
      transaction_count: number;
      blockchain_height: number;
      start_height: number;
      scanned_height: number;
      spent_outputs: Array<{
        amount: string;
        key_image: string;
        tx_pub_key: string;
        out_index: number;
        /**
         * Subaddress index of the output BEING SPENT (`(0,0)` = primary
         * address), taken from the spend record itself and NOT from the
         * enclosing transaction (that one is the change index and would be
         * just as wrong).
         *
         * Load-bearing for the balance. The wallet recomputes this output's key
         * image with its spend key to tell a real spend from a ring decoy, and
         * the key image folds in the subaddress secret. Recomputing a
         * subaddress spend against the primary index never matches, so the
         * spend is dismissed as a decoy and its amount is never subtracted:
         * the wallet shows money it no longer has, forever, and later sends
         * fail for insufficient funds while the UI insists otherwise.
         *
         * Optional because a legacy flat backend omits it. Absent is NOT read
         * as primary on the balance path; see `fetchAllBalances`'s
         * `strictSpentSubaddrIndex` option for how that fails closed.
         */
        subaddr_index?: { major: number; minor: number };
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
        amount: string;
        public_key: string;
        tx_pub_key: string;
        index: number;
        global_index: number;
        height: number;
        rct: string;
        spend_key_images: string[];
        /**
         * Subaddress index this output was received at. The namespaced backend
         * always emits it (`(0,0)` = primary address); a pre-subaddress / legacy
         * flat backend omits it, so it is optional and read as primary when
         * absent. send-handler threads a non-primary index into the wasm spend
         * path so a subaddress output stays spendable (money gate: a wrong/absent
         * index would make the key image mismatch and strand the output).
         */
        subaddr_index?: { major: number; minor: number };
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
        total_received: string;
        spent_outputs: Array<{
          amount: string;
          key_image: string;
          tx_pub_key: string;
          out_index: number;
          /** Subaddress index of the output being spent; see `getLwsBalance`. */
          subaddr_index?: { major: number; minor: number };
        }>;
        payment_id?: string;
        /**
         * Subaddress index this tx was received at (`(0,0)` = primary address).
         * Emitted by the namespaced backend; a legacy flat backend omits it, so
         * it is optional and read as primary when absent. History is display
         * only, so this never gates money movement (the spend path reads the
         * per-OUTPUT index off getUnspentOuts instead).
         */
        subaddr_index?: { major: number; minor: number };
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
    /**
     * Number of account-0 minor subaddress indices to ask the backend to
     * provision at the LWS alongside registration. Omit (the default) for
     * today's exact behavior: the backend then falls back to its own
     * FEATURE_XMR_SUBADDR_PROVISIONING policy and the field is not even sent.
     */
    subaddrCount?: number,
    /**
     * Restore proof-of-work nonce. Required when the operator prices the
     * requested depth (`/capabilities` -> `restore.pow_*`), ignored otherwise.
     * Bound to `(asset, address, start_height)`.
     *
     * Without it a deep import is refused, and because registration here is
     * best-effort and the rejection is swallowed, the symptom is a balance that
     * reads zero forever with no error. Same gate that made every GRIN balance
     * unreadable on a priced backend.
     */
    restorePowNonce?: number,
  ): Promise<
    ApiResponse<{ success: boolean; message: string; start_height?: number }>
  >;

  /**
   * Ask the backend to provision account-0 minor subaddress indices
   * `[0 .. maxMinor]` at the LWS, so the LWS attributes receipts on those
   * subaddresses to this account.
   *
   * Returns the backend's `provisioned_minor_max`: the highest minor index it
   * confirms is provisioned. That number is the ONLY source of truth for the
   * client's issuance ceiling (money gate G4): the client must never assume a
   * ceiling from a hardcoded constant, because the LWS's own
   * `--max-subaddresses` can cap the batch below what was asked for. Handing
   * out a subaddress the LWS is not scanning would make funds sent to it
   * INVISIBLE to the wallet.
   *
   * Fails (never resolves to a success) when the backend dialect has no such
   * route: a false success would raise the ceiling with nothing provisioned.
   */
  provisionSubaddrs(
    userId: string,
    asset: 'xmr' | 'wow',
    address: string,
    viewKey: string,
    maxMinor: number,
  ): Promise<ApiResponse<{ provisioned_minor_max: number }>>;

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

    async submitLwsTx(asset, txHex) {
      // Only asset + tx_hex. The recipient address, amount, and tx_hash are NOT
      // sent: the LWS broadcasts from the raw tx alone, and transmitting them would
      // expose a sender<->recipient<->amount graph to the operator on every send.
      return client.request(lwsPath(client, 'submit'), {
        method: 'POST',
        body: JSON.stringify({ asset, tx_hex: txHex }),
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
          total_received: string;
          spent_outputs?: Array<{
            amount: string;
            key_image: string;
            tx_pub_key: string;
            out_index: number;
            subaddr_index?: { major: number; minor: number };
          }>;
          payment_id?: string;
          subaddr_index?: { major: number; minor: number };
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
            // Passed through verbatim when present. Absent on the legacy flat
            // dialect, and left absent rather than defaulted to `(0,0)` so a
            // consumer can tell "primary" from "this backend doesn't say".
            ...(t.subaddr_index !== undefined ? { subaddr_index: t.subaddr_index } : {}),
          })),
          scanned_height: d.scanned_height ?? 0,
          blockchain_height: d.blockchain_height ?? 0,
        },
        ...(r.status !== undefined ? { status: r.status } : {}),
      };
    },

    async registerLws(userId, asset, address, viewKey, startHeight, subaddrCount, restorePowNonce) {
      return client.request('/wallet/lws/register', {
        method: 'POST',
        body: JSON.stringify({
          user_id: userId,
          asset,
          address,
          view_key: viewKey,
          start_height: startHeight,
          // Omitted unless solved, so an unpriced backend receives exactly the
          // body it received before and the field is absent rather than null.
          ...(restorePowNonce !== undefined ? { restore_pow_nonce: restorePowNonce } : {}),
          // Only present when the caller asked for a batch. Omitted otherwise,
          // so the request body is byte-identical to before and the backend
          // applies its own FEATURE_XMR_SUBADDR_PROVISIONING default.
          ...(subaddrCount !== undefined ? { subaddr_count: subaddrCount } : {}),
        }),
      });
    },

    async provisionSubaddrs(userId, asset, address, viewKey, maxMinor) {
      if (client.getWalletApiStyle() !== 'namespaced') {
        // The legacy flat backend has no provisioning route. Report it as an
        // error, NOT a no-op success: the caller uses the returned ceiling to
        // decide whether it may hand out a subaddress, and a fake success would
        // green-light an address the LWS is not scanning (invisible funds).
        return { error: 'subaddress provisioning is not supported on this backend' };
      }
      if (!Number.isInteger(maxMinor) || maxMinor < 0) {
        return { error: `invalid maxMinor ${maxMinor}` };
      }
      const r = await client.request<{ provisioned_minor_max?: unknown }>(
        '/wallet/lws/provision_subaddrs',
        {
          method: 'POST',
          body: JSON.stringify({
            user_id: userId,
            asset,
            address,
            view_key: viewKey,
            max_minor: maxMinor,
          }),
        },
      );
      if (r.error || !r.data) {
        return {
          error: r.error ?? 'provision_subaddrs failed',
          ...(r.status !== undefined ? { status: r.status } : {}),
          ...(r.code !== undefined ? { code: r.code } : {}),
        };
      }
      // Fail closed on a body we can't read a ceiling out of. Silently
      // substituting `maxMinor` (or 0-as-success) here is exactly the bug that
      // strands funds: the caller would trust a ceiling nobody provisioned.
      const max = r.data.provisioned_minor_max;
      if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
        return {
          error: 'provision_subaddrs returned no usable provisioned_minor_max',
          ...(r.status !== undefined ? { status: r.status } : {}),
        };
      }
      return { data: { provisioned_minor_max: max }, status: r.status ?? 200 };
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
