/**
 * The popup's THORChain instance and the checks around a memo deposit.
 *
 * One instance per popup so THORChain's one-request-per-second spacing holds
 * across the swap screen and the send path. Its policy is re-read from our
 * backend's `/capabilities` (`swaps.thorchain`) on every availability check:
 * that is how an operator turns THORChain, or one asset, off without a client
 * release. An unreachable or older backend sends no policy, which means
 * `auto`: THORChain's own pools and halt flags still decide.
 */

import { api, loadCapabilities, type PendingOutgoingContext } from '@smirk/core';
import {
  ThorchainSwap,
  DEFAULT_THORCHAIN_POLICY,
  type ThorchainPolicy,
  type ThorchainQuoteData,
} from '@smirk/swap';
import { nativeFetch } from './native-fetch';

let instance: ThorchainSwap | null = null;

async function policy(): Promise<ThorchainPolicy> {
  const caps = await loadCapabilities(api).catch(() => null);
  const t = caps?.swaps?.thorchain;
  if (!t) return DEFAULT_THORCHAIN_POLICY;
  return { enabled: t.enabled !== false, ...(t.assets ? { assets: t.assets } : {}) };
}

/** Affiliate fee, from the build. Off unless a registered THORName is set. */
function affiliate(): { name: string; bps: number } | undefined {
  const name = (import.meta.env.VITE_THORCHAIN_AFFILIATE ?? '').trim();
  const bps = Number(import.meta.env.VITE_THORCHAIN_AFFILIATE_BPS ?? '0');
  if (!name || !Number.isInteger(bps) || bps <= 0) return undefined;
  return { name, bps };
}

/** The popup's THORChain client. Throws if the desktop transport is missing. */
export function thorchainSwap(): ThorchainSwap {
  if (instance) return instance;
  const transport = nativeFetch();
  const aff = affiliate();
  instance = new ThorchainSwap({
    policy,
    ...(transport ? { fetch: transport } : {}),
    ...(aff ? { affiliate: aff } : {}),
  });
  return instance;
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
