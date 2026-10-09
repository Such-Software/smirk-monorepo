/**
 * The popup's THORChain instance and the checks around a memo deposit.
 *
 * One instance per popup so THORChain's one-request-per-second spacing holds
 * across the swap screen and the send path. Its policy is re-read from our
 * backend's `/capabilities` (`swaps.thorchain`) on every availability check:
 * that is how an operator turns THORChain, or one asset, off without a client
 * release. An unreachable or older backend sends no policy, which means `auto`
 * for BTC and LTC (THORChain's own pools and halt flags decide) and `off` for
 * XMR: XMR is offered only when the backend sends `assets.xmr = 'auto'`
 * (`DEFAULT_ASSET_POLICY` in @smirk/swap).
 */

import { api, loadCapabilities, type PendingOutgoingContext } from '@smirk/core';
import { mustGetAsset } from '@smirk/assets';
import {
  ThorchainSwap,
  DEFAULT_THORCHAIN_POLICY,
  DEFAULT_THORNODE_URL,
  serverAffiliate,
  type SwapError,
  type SwapQuote,
  type ThorchainAffiliate,
  type ThorchainPolicy,
  type ThorchainQuoteData,
} from '@smirk/swap';
import type { SwapInFlight, SwapQuoteSummary } from '@smirk/ui';
import { nativeFetch } from './native-fetch';
import { atomicToText } from './format';

let instance: ThorchainSwap | null = null;

async function policy(): Promise<ThorchainPolicy> {
  const caps = await loadCapabilities(api).catch(() => null);
  const t = caps?.swaps?.thorchain;
  if (!t) return DEFAULT_THORCHAIN_POLICY;
  return { enabled: t.enabled !== false, ...(t.assets ? { assets: t.assets } : {}) };
}

/** The build's affiliate, a fallback for wallet servers that send no THORChain policy. */
function buildAffiliate(): ThorchainAffiliate | undefined {
  const name = (import.meta.env.VITE_THORCHAIN_AFFILIATE ?? '').trim();
  const bps = Number(import.meta.env.VITE_THORCHAIN_AFFILIATE_BPS ?? '0');
  if (!name || !Number.isInteger(bps) || bps <= 0) return undefined;
  return { name, bps };
}

/**
 * The affiliate for the next quote: the wallet server's
 * `swaps.thorchain.affiliate`, re-read every quote so the operator can set or
 * change it without a release. The swap library caps the fee and checks the
 * THORName on THORChain before naming it.
 */
async function affiliate(): Promise<ThorchainAffiliate | undefined> {
  const caps = await loadCapabilities(api).catch(() => null);
  return serverAffiliate(caps?.swaps?.thorchain, buildAffiliate());
}

/** The popup's THORChain client. Throws if the desktop transport is missing. */
export function thorchainSwap(): ThorchainSwap {
  if (instance) return instance;
  const transport = nativeFetch();
  instance = new ThorchainSwap({
    policy,
    affiliateSource: affiliate,
    ...(transport ? { fetch: transport } : {}),
  });
  return instance;
}

/**
 * The largest drop, in basis points, the binding quote may show against the
 * estimate the user confirmed. Confirm quotes again with the destination, and
 * that second quote is what gets signed; beyond this the user re-quotes.
 */
export const MAX_REQUOTE_DRIFT_BPS = 50;

/** Who answers THORChain requests, for the disclosure on the quote screen. */
export function thorchainGatewayHost(url = DEFAULT_THORNODE_URL): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * What the quote screen shows for a THORChain quote. THORChain takes its fees
 * in the destination asset and the estimate is already net of them, so the
 * fee row is the destination-asset total, labelled as included, never the
 * library's `feeEstimate` of zero in the source asset. The notices say what
 * the memo's price limit does, when the deposit must go out, and who sees the
 * request.
 */
export function thorchainQuoteSummary(q: SwapQuote, gatewayHost = thorchainGatewayHost()): SwapQuoteSummary {
  const data = q.implementationData as ThorchainQuoteData;
  const to = mustGetAsset(q.toAsset);
  const amt = (atomic: string) => `${atomicToText(atomic, to.id)} ${to.ticker}`;
  const parts = [`liquidity ${amt(data.fees.liquidity)}`, `outbound ${amt(data.fees.outbound)}`];
  const limitPct = (data.toleranceBps / 100).toString();
  const xmr = q.fromAsset === 'xmr';
  // The affiliate fee is Smirk's own, so it gets its own line rather than
  // hiding among THORChain's.
  const smirkFee = data.affiliate && data.affiliate.bps > 0
    ? `Smirk fee ${(data.affiliate.bps / 100).toString()}% (${amt(data.fees.affiliate)}), also already taken out of the estimate.`
    : null;
  return {
    tradeId: '',
    fromAsset: q.fromAsset,
    toAsset: q.toAsset,
    fromAmountAtomic: q.fromAmount,
    toAmountEstimateAtomic: q.toAmountEstimate,
    feeEstimateAtomic: data.fees.total,
    feeAssetId: q.toAsset,
    feeIncludedInEstimate: true,
    provider: 'thorchain',
    etaSeconds: q.etaSeconds,
    expiresAtMs: q.expiresAt.getTime(),
    providerData: data,
    notices: [
      `THORChain's fees (${parts.join(', ')}) are already taken out of the estimate.`,
      ...(smirkFee ? [smirkFee] : []),
      `The deposit sets a price limit ${limitPct}% below the estimate. If the price moves further before THORChain fills it, THORChain refunds the deposit less its outbound fee.`,
      `On confirm, Smirk quotes again with your address. If that quote is more than ${MAX_REQUOTE_DRIFT_BPS / 100}% worse than this one, you are asked to re-quote instead.`,
      `The deposit can be sent only before this quote expires; after that, get a new quote.`,
      `Quotes and status checks go straight to THORChain's public gateway (${gatewayHost}), not through your wallet server. It sees your IP address and, when you confirm, your receive${xmr ? ' and refund' : ''} address.`,
    ],
  };
}

/**
 * Refuse a binding quote that is materially worse than the one the user
 * confirmed. Throws a `quote_expired` swap error naming both figures, which
 * the quote screen turns into a re-quote.
 */
export function assertRequoteWithinDrift(shown: SwapQuoteSummary, fresh: SwapQuote): void {
  const before = BigInt(shown.toAmountEstimateAtomic);
  const after = BigInt(fresh.toAmountEstimate);
  if (after * 10_000n >= before * BigInt(10_000 - MAX_REQUOTE_DRIFT_BPS)) return;
  const to = mustGetAsset(fresh.toAsset);
  const err = new Error(
    `The rate moved from ${atomicToText(before.toString(), to.id)} to ${atomicToText(after.toString(), to.id)} ${to.ticker} since this quote. Get a new quote.`,
  ) as SwapError;
  err.code = 'quote_expired';
  throw err;
}

/**
 * Confirm a THORChain quote: quote again with the destination (that binding
 * quote is what gets signed), refuse it when it is materially worse than what
 * the user confirmed, then re-check liveness and hand back the deposit. The
 * refund address is always the wallet's own: THORChain cannot see a Monero
 * sender, and a typo here would lose a refund.
 */
export async function confirmThorchainSwap(args: {
  swap: Pick<ThorchainSwap, 'quote' | 'start'>;
  quote: SwapQuoteSummary;
  toAddress: string;
  ownAddress: (asset: string) => string | undefined;
}): Promise<SwapInFlight> {
  const { swap, quote, toAddress } = args;
  const ownRefund = args.ownAddress(quote.fromAsset);
  if (quote.fromAsset === 'xmr' && !ownRefund) throw new Error('This wallet has no XMR address for a refund.');
  const fresh = await swap.quote({
    fromAsset: quote.fromAsset,
    toAsset: quote.toAsset,
    fromAmount: quote.fromAmountAtomic,
    toAddress,
    ...(quote.fromAsset === 'xmr' ? { refundAddress: ownRefund! } : {}),
  });
  assertRequoteWithinDrift(quote, fresh);
  const started = await swap.start({ quote: fresh, toAddress });
  const data = fresh.implementationData as ThorchainQuoteData;
  return {
    id: started.id,
    fromAsset: fresh.fromAsset,
    toAsset: fresh.toAsset,
    fromAmountAtomic: fresh.fromAmount,
    toAmountEstimateAtomic: fresh.toAmountEstimate,
    depositAddress: started.depositAddress,
    provider: 'thorchain',
    ...(started.memo ? { memo: started.memo } : {}),
    depositBeforeMs: data.expiresAtMs,
    state: { state: 'pending', reason: 'awaiting_deposit' },
  };
}

/** Outcome of checking a send against a THORChain swap-deposit context. */
export type MemoDepositCheck =
  | { kind: 'not-a-memo-deposit' }
  | { kind: 'refuse'; error: string }
  | { kind: 'send-with-memo'; memo: string };

/**
 * Decide what a send carrying a THORChain context may do. Runs immediately
 * before signing, and is the last gate between a quote and a vault deposit:
 *
 * - the send must still be the quoted deposit: same asset, same vault
 *   address, the exact quoted amount, not a sweep;
 * - a send that keeps the vault address but changes anything else is
 *   refused, because a vault deposit without its memo is not a swap;
 * - THORChain must still be live, unpaused, before the deadline, and on the
 *   same vault (a fresh `preflight`).
 */
export async function checkMemoDeposit(args: {
  ctx: PendingOutgoingContext | undefined;
  seed: { fromAssetId?: string; toAddress?: string } | undefined;
  fields: { fromAssetId: string; toAddress: string; amountAtomic: bigint; sweep: boolean };
  swap?: Pick<ThorchainSwap, 'preflight'>;
}): Promise<MemoDepositCheck> {
  const { ctx, seed, fields } = args;
  if (!ctx || ctx.kind !== 'swap-deposit' || ctx.memo === undefined) return { kind: 'not-a-memo-deposit' };
  const vault = seed?.toAddress;
  if (!vault) return { kind: 'refuse', error: 'This swap deposit lost its details. Start the swap again.' };
  if (fields.toAddress !== vault) {
    // The user typed another destination: an ordinary send, no memo.
    return { kind: 'not-a-memo-deposit' };
  }
  if (seed?.fromAssetId !== fields.fromAssetId) {
    return { kind: 'refuse', error: 'This address is a THORChain vault for another coin. Start the swap again.' };
  }
  if (fields.sweep) return { kind: 'refuse', error: 'A swap deposit cannot be a sweep. Send the quoted amount.' };
  if (ctx.amountAtomic === undefined || fields.amountAtomic !== BigInt(ctx.amountAtomic)) {
    return { kind: 'refuse', error: 'The amount differs from the quote. Get a new quote for this amount.' };
  }
  if (ctx.depositBeforeMs === undefined) {
    return { kind: 'refuse', error: 'This swap deposit has no deadline recorded. Start the swap again.' };
  }
  const data: ThorchainQuoteData = {
    provider: 'thorchain',
    fromAsset: fields.fromAssetId as ThorchainQuoteData['fromAsset'],
    toAsset: ctx.toAsset as ThorchainQuoteData['toAsset'],
    memo: ctx.memo,
    inboundAddress: vault,
    expiresAtMs: ctx.depositBeforeMs,
    fees: { total: '0', affiliate: '0', outbound: '0', liquidity: '0' },
    toleranceBps: 0,
  };
  try {
    await (args.swap ?? thorchainSwap()).preflight(data);
  } catch (e) {
    return { kind: 'refuse', error: e instanceof Error ? e.message : 'THORChain is not accepting this deposit now.' };
  }
  return { kind: 'send-with-memo', memo: ctx.memo };
}
