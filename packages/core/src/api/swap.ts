/**
 * Swap bookkeeping endpoints (Trocador). The extension talks to
 * api.trocador.app directly for the actual quote/create/status calls
 * (V0_3_PLAN.md Decision 2, client-direct architecture). These
 * methods touch our own backend's persistence so the user's swap
 * history survives across devices and the backend webhook receiver
 * has somewhere to write updates into.
 */

import type { ApiClient, ApiResponse } from './client';

export interface SwapRecord {
  trade_id: string;
  from_asset: string;
  to_asset: string;
  amount_from_atomic: string;
  amount_to_atomic: string | null;
  deposit_address: string;
  recipient_address: string;
  refund_address: string | null;
  provider: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSwapPayload {
  trade_id: string;
  from_asset: string;
  to_asset: string;
  amount_from_atomic: string;
  deposit_address: string;
  recipient_address: string;
  refund_address?: string;
  provider?: string;
  /** Shared-secret echoed back by Trocador via the `passthrough` field
   *  on every webhook delivery. The receiver compares this verbatim. */
  webhook_token: string;
}

export interface SwapMethods {
  /** Record a swap the wallet just created on Trocador. Idempotent on
   *  `trade_id`. */
  createSwap(body: CreateSwapPayload): Promise<ApiResponse<SwapRecord>>;
  /** Read one swap (user-scoped). */
  getSwap(tradeId: string): Promise<ApiResponse<SwapRecord>>;
  /** List the user's recent swaps. */
  listSwaps(): Promise<ApiResponse<{ swaps: SwapRecord[] }>>;
}

// smirk-backend-core (namespaced) has NOT ported the /swaps persistence
// endpoints, so every /swaps request 404s there. Swaps still work end-to-end
// against Trocador directly (client-direct architecture); only the cross-device
// history mirror is unavailable. Degrade cleanly instead of throwing a 404: the
// swap UI already treats an empty list / errored read as "no backend record" and
// falls back to live Trocador polling.
const SWAPS_UNSUPPORTED = 'Swap history is not available on this backend.';

export function createSwapMethods(client: ApiClient): SwapMethods {
  const swapsUnsupported = () => client.getWalletApiStyle() === 'namespaced';
  return {
    async createSwap(body) {
      // Best-effort backend tracking; the caller tolerates an error (it only means
      // webhook-driven status updates won't be authenticated, direct polling works).
      if (swapsUnsupported()) return { error: SWAPS_UNSUPPORTED };
      // NOT retryable — non-idempotent at the network layer (Trocador's
      // /new_trade already created the row); the backend's idempotency
      // is on trade_id, but a retry after a successful response that
      // didn't reach us would still POST the same body, which the
      // backend handles correctly. Skip the retry to keep this lean.
      return client.request<SwapRecord>('/swaps', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    async getSwap(tradeId) {
      // No data -> the caller falls through to live Trocador status.
      if (swapsUnsupported()) return { error: SWAPS_UNSUPPORTED };
      return client.retryableRequest<SwapRecord>(
        `/swaps/${encodeURIComponent(tradeId)}`,
        { method: 'GET' },
      );
    },
    async listSwaps() {
      // Empty list -> the recent-swaps surface simply shows nothing to resume.
      if (swapsUnsupported()) return { data: { swaps: [] } };
      return client.retryableRequest<{ swaps: SwapRecord[] }>(`/swaps`, {
        method: 'GET',
      });
    },
  };
}
