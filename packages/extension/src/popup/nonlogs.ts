/**
 * The popup's NonLogs client: our backend's `/swaps/nonlogs/*` routes.
 *
 * NonLogs signs every private call with an HMAC secret, so the wallet never
 * talks to NonLogs: it talks to its own wallet server, which holds the key,
 * records which user created which swap, and proxies the public order books
 * so the user's IP never reaches NonLogs. Whether the server offers NonLogs
 * at all is read from `/capabilities` (`swaps.nonlogs`), so an operator turns
 * it on or off without a client release.
 */

import { api, loadCapabilities } from '@smirk/core';
import { NonlogsBackendError, NonlogsSwap, type NonlogsBackend } from '@smirk/swap';

let instance: NonlogsSwap | null = null;

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await api.request<unknown>(path, init);
  if (res.error !== undefined || res.data === undefined) {
    throw new NonlogsBackendError(res.error ?? 'No answer from the wallet server.', res.code, res.status);
  }
  return res.data;
}

const backend: NonlogsBackend = {
  assets: () => call('/swaps/nonlogs/assets'),
  quote: (body) => call('/swaps/nonlogs/quote', { method: 'POST', body: JSON.stringify(body) }),
  // Not retried here: the server retries an uncertain outcome with the same
  // upstream id, and the wallet's own retry reuses the quote's request id.
  create: (body) => call('/swaps/nonlogs', { method: 'POST', body: JSON.stringify(body) }),
  status: (id) => call(`/swaps/nonlogs/${encodeURIComponent(id)}`),
  orderbook: (pair) => call(`/swaps/nonlogs/orderbook/${encodeURIComponent(pair)}`),
};

/** The popup's NonLogs client. */
export function nonlogsSwap(): NonlogsSwap {
  if (!instance) instance = new NonlogsSwap({ backend });
  return instance;
}

/** Whether this wallet server brokers NonLogs swaps. */
export async function nonlogsOffered(): Promise<boolean> {
  const caps = await loadCapabilities(api).catch(() => null);
  return caps?.swaps?.nonlogs?.enabled === true;
}

/**
 * NonLogs pays out and refunds to the addresses fixed at creation, which
 * cannot be changed afterwards. The wallet only ever names its own: a typo
 * or a pasted foreign address here would send the coins somewhere this
 * wallet cannot reach. Returns the reason to refuse, or null.
 */
export function ownAddressesOnly(args: {
  toAddress: string;
  refundAddress: string;
  ownTo: string | undefined;
  ownFrom: string | undefined;
}): string | null {
  if (!args.ownTo || !args.ownFrom) return 'This wallet has no address for one of these coins yet.';
  if (args.toAddress !== args.ownTo) return 'NonLogs swaps pay only to this wallet. Use your own receive address.';
  if (args.refundAddress !== args.ownFrom) return 'NonLogs refunds only to this wallet. Use your own refund address.';
  return null;
}
