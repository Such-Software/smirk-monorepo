/**
 * THORChain swaps: BTC and LTC, and XMR only when the wallet server opts in.
 *
 * Non-custodial in the same sense as a normal send: the wallet signs one
 * transaction to a THORChain vault (the "inbound address") carrying a swap
 * memo, and THORChain's validators pay the output to the user's own address.
 * Nothing here holds keys or builds transactions; `start()` returns the vault
 * address and memo, and the wallet's ordinary send path signs and broadcasts.
 *
 * WHERE THE MEMO GOES
 * -------------------
 * - BTC / LTC: a trailing zero-value `OP_RETURN` output, at most 80 bytes.
 *   The quote API itself says so: "first output to inbound_address, second
 *   change back to self, third OP_RETURN, limited to 80 bytes."
 * - XMR: `tx_extra` arbitrary data (marker 127), at most 254 bytes. THORNode's
 *   Monero scanner (bifrost/pkg/chainclients/monero/scanner.go) takes each
 *   inbound transfer's memo from the Serai-derived signer's `note`, and that
 *   signer writes its own outbound `OUT:` memos the same way, through
 *   monero-oxide's arbitrary data. A Monero deposit has no visible sender, so
 *   THORChain records it from `unknownSenderAddress` and can only refund to an
 *   address written into the memo: the refund address is mandatory for XMR.
 *
 * WHEN IT IS ON
 * -------------
 * Nothing is enabled at build time. Every quote, and again every signature,
 * asks THORChain live, and a pair is offered only while all of these hold for
 * both chains: the pool reports `Available`, the chain has an inbound address,
 * and `inbound_addresses` reports it neither halted nor trading-paused. On top
 * of that, an operator policy (our backend's capabilities) can switch the
 * provider or any single asset off without a client release.
 *
 * XMR is the exception to "absent means auto": it is closed unless the policy
 * says `xmr: 'auto'` in so many words. Its only evidence so far is a
 * synthesized fixture, never a recorded deposit against a real THORChain
 * Monero vault, and an XMR deposit THORChain cannot attribute has no refund
 * path. So a THORChain listing alone never turns it on, and neither does a
 * missing, unreadable or older backend policy. The operator opens it, with a
 * deposit cap, once one recorded deposit with an observed memo and an exercised
 * refund replaces `xmr-synthesized.json`.
 *
 * KNOWN LIMIT
 * -----------
 * A BTC or LTC deposit cannot name a Monero destination: the memo (95-char
 * address plus limit) is longer than 80 bytes, and the quote API refuses it
 * ("generated memo too long for source chain"). THORChain's answer is a
 * memoless reference registered with a RUNE deposit, which this wallet has
 * no RUNE to make. So BTC/LTC to XMR is refused with that explanation; XMR to
 * BTC/LTC works, because Monero's memo field holds 254 bytes.
 *
 * Reference: https://dev.thorchain.org/swap-guide/quickstart-guide.html,
 * https://dev.thorchain.org/swap-guide/memoless-swaps.html,
 * https://dev.thorchain.org/chain-clients/monero-design.html
 */

import type { AssetId } from '@smirk/assets';
import type {
  QuoteRequest,
  Swap,
  SwapError,
  SwapId,
  SwapKind,
  SwapStartParams,
  SwapQuote,
  SwapStarted,
  SwapStatus,
} from './types';

/** Assets this provider can ever route. Availability is decided live. */
export type ThorchainAsset = 'btc' | 'ltc' | 'xmr';

interface AssetSpec {
  /** THORChain pool id. */
  pool: string;
  /** Chain id as `inbound_addresses` reports it. */
  chain: string;
  /** Native decimals; THORChain counts every asset in 1e8 units. */
  decimals: number;
  /** Largest memo the source chain can carry, in bytes. */
  memoMaxBytes: number;
}

const SPEC: Readonly<Record<ThorchainAsset, AssetSpec>> = {
  btc: { pool: 'BTC.BTC', chain: 'BTC', decimals: 8, memoMaxBytes: 80 },
  ltc: { pool: 'LTC.LTC', chain: 'LTC', decimals: 8, memoMaxBytes: 80 },
  // monero-oxide MAX_ARBITRARY_DATA_SIZE: a 255-byte tx_extra nonce less its marker.
  xmr: { pool: 'XMR.XMR', chain: 'XMR', decimals: 12, memoMaxBytes: 254 },
};

const CHAIN_DECIMALS: Readonly<Record<string, number>> = { BTC: 8, LTC: 8, XMR: 12, THOR: 8 };

/** Per-asset operator switch: `auto` follows THORChain, `off` hides it. */
export type ThorchainAssetPolicy = 'auto' | 'off';

/**
 * Operator policy, normally from our backend's `/capabilities`
 * (`swaps.thorchain`). An absent asset takes {@link DEFAULT_ASSET_POLICY}:
 * `auto` (THORChain's own state decides) for BTC and LTC, `off` for XMR. This
 * is the remote kill switch, and for XMR the only way on.
 */
export interface ThorchainPolicy {
  enabled: boolean;
  assets?: Partial<Record<ThorchainAsset, ThorchainAssetPolicy>>;
}

export const DEFAULT_THORCHAIN_POLICY: ThorchainPolicy = { enabled: true };

/**
 * What an asset does when the policy does not name it. XMR is closed until an
 * operator opens it explicitly (see the header, WHEN IT IS ON).
 */
export const DEFAULT_ASSET_POLICY: Readonly<Record<ThorchainAsset, ThorchainAssetPolicy>> = {
  btc: 'auto',
  ltc: 'auto',
  xmr: 'off',
};

export interface ThorchainSwapOptions {
  /**
   * Thornode REST base URL. Defaults to a public gateway. Quotes and vault
   * addresses come from here, so a wallet operator can point it at their own
   * node.
   */
  thornodeUrl?: string;
  /** `fetch` impl. Defaults to `globalThis.fetch`. Injectable for tests. */
  fetch?: typeof fetch;
  /**
   * Affiliate THORName and fee in basis points. Off unless both are set: the
   * name must be registered on THORChain first, or quotes fail.
   */
  affiliate?: { name: string; bps: number };
  /**
   * Price protection written into the memo as a limit, in basis points below
   * the quoted output. THORChain refunds instead of filling worse than this.
   * Default 300 (3 percent).
   */
  toleranceBps?: number;
  /** Operator policy. Re-read on every availability check. */
  policy?: () => ThorchainPolicy | Promise<ThorchainPolicy>;
  /** Clock, for tests. */
  now?: () => number;
  /** Sleep, for tests of the request spacing. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_THORNODE_URL = 'https://gateway.liquify.com/chain/thorchain_api';

/** THORChain public endpoints allow about one request per second. */
const MIN_REQUEST_SPACING_MS = 1_000;
/** Quotes are honored for at most ten minutes, sooner if THORChain says so. */
const MAX_QUOTE_LIFETIME_MS = 10 * 60_000;
/** Availability is reused this long by quotes; signing always re-checks. */
const AVAILABILITY_TTL_MS = 30_000;

export interface AssetAvailability {
  available: boolean;
  /** Why not, in words a user can act on. */
  reason?: string;
  inboundAddress?: string;
  dustThreshold?: string;
}

export type ThorchainAvailability = Record<ThorchainAsset, AssetAvailability>;

/** What `quote()` hands back to `start()` and to the wallet's preflight. */
export interface ThorchainQuoteData {
  provider: 'thorchain';
  fromAsset: ThorchainAsset;
  toAsset: ThorchainAsset;
  /** Absent on an indicative quote made without a destination. */
  memo?: string;
  destination?: string;
  refundAddress?: string;
  inboundAddress: string;
  /** Unix ms after which the deposit must not be sent. */
  expiresAtMs: number;
  recommendedMinAmountIn?: string;
  /** Fees in the destination asset's atomic units. */
  fees: { total: string; affiliate: string; outbound: string; liquidity: string };
  toleranceBps: number;
}

interface ThorPool {
  asset: string;
  status: string;
}

interface ThorInbound {
  chain: string;
  address?: string;
  halted?: boolean;
  chain_trading_paused?: boolean;
  global_trading_paused?: boolean;
  dust_threshold?: string;
}

interface ThorQuote {
  memo?: string;
  inbound_address?: string;
  expected_amount_out?: string;
  expiry?: number;
  recommended_min_amount_in?: string;
  total_swap_seconds?: number;
  inbound_confirmation_seconds?: number;
  fees?: { total?: string; affiliate?: string; outbound?: string; liquidity?: string };
}

interface ThorTxStatus {
  tx?: { id?: string; chain?: string };
  planned_out_txs?: Array<{ chain: string; refund?: boolean; coin?: { amount?: string } }>;
  out_txs?: Array<{
    id?: string;
    chain?: string;
    memo?: string;
    coins?: Array<{ asset?: string; amount?: string }>;
  }>;
  stages?: {
    inbound_observed?: { started?: boolean; completed?: boolean };
    inbound_confirmation_counted?: { completed?: boolean };
    inbound_finalised?: { completed?: boolean };
    swap_status?: { pending?: boolean };
    swap_finalised?: { completed?: boolean };
    outbound_signed?: { completed?: boolean };
  };
}

export class ThorchainSwap implements Swap {
  readonly kind: SwapKind = 'aggregator';

  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly toleranceBps: number;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();
  private cached: { at: number; value: ThorchainAvailability } | null = null;

  constructor(private readonly opts: ThorchainSwapOptions = {}) {
    this.base = (opts.thornodeUrl ?? DEFAULT_THORNODE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const t = opts.toleranceBps ?? 300;
    if (!Number.isInteger(t) || t < 1 || t > 5_000) {
      throw new Error('toleranceBps must be an integer between 1 and 5000');
    }
    this.toleranceBps = t;
    const aff = opts.affiliate;
    if (aff && (!/^[a-z0-9_+-]{1,30}$/i.test(aff.name) || !Number.isInteger(aff.bps) || aff.bps < 0 || aff.bps > 1_000)) {
      throw new Error('affiliate needs a THORName and 0..1000 basis points');
    }
  }

  /** True when THORChain could ever route this pair. Live state is separate. */
  supports(from: AssetId, to: AssetId): boolean {
    return from !== to && isThorAsset(from) && isThorAsset(to);
  }

  /**
   * Live availability per asset, combining operator policy and THORChain's
   * pools and inbound addresses. Cached briefly for browsing; pass `fresh` to
   * bypass the cache (signing does).
   */
  async availability(fresh = false): Promise<ThorchainAvailability> {
    const t = this.now();
    if (!fresh && this.cached && t - this.cached.at < AVAILABILITY_TTL_MS) return this.cached.value;
    const policy = (await this.opts.policy?.()) ?? DEFAULT_THORCHAIN_POLICY;
    // Nothing the policy allows: answer without asking THORChain, so a
    // switched-off provider sends nothing to the gateway.
    const allowed = (Object.keys(SPEC) as ThorchainAsset[]).filter((a) => policyAllows(policy, a));
    if (allowed.length === 0) {
      const value = {} as ThorchainAvailability;
      for (const asset of Object.keys(SPEC) as ThorchainAsset[]) value[asset] = assess(asset, policy, [], []);
      this.cached = { at: t, value };
      return value;
    }
    const [pools, inbound] = await Promise.all([
      this.get<ThorPool[]>('/thorchain/pools'),
      this.get<ThorInbound[]>('/thorchain/inbound_addresses'),
    ]);
    const value = {} as ThorchainAvailability;
    for (const asset of Object.keys(SPEC) as ThorchainAsset[]) {
      value[asset] = assess(asset, policy, pools, inbound);
    }
    this.cached = { at: t, value };
    return value;
  }

  /** Pairs offered right now, for the swap screen. */
  async availablePairs(): Promise<Array<{ from: ThorchainAsset; to: ThorchainAsset }>> {
    const a = await this.availability();
    const live = (Object.keys(SPEC) as ThorchainAsset[]).filter((x) => a[x].available);
    const out: Array<{ from: ThorchainAsset; to: ThorchainAsset }> = [];
    for (const from of live) {
      for (const to of live) {
        if (from === to) continue;
        // BTC/LTC cannot carry a Monero destination in 80 bytes (see header).
        if (to === 'xmr' && from !== 'xmr') continue;
        out.push({ from, to });
      }
    }
    return out;
  }

  async quote(req: QuoteRequest): Promise<SwapQuote> {
    const from = req.fromAsset;
    const to = req.toAsset;
    if (!this.supports(from, to)) throw swapError('asset_pair_unsupported', `THORChain does not route ${from} to ${to}.`);
    const fromA = from as ThorchainAsset;
    const toA = to as ThorchainAsset;
    if (toA === 'xmr' && fromA !== 'xmr') {
      throw swapError(
        'asset_pair_unsupported',
        `A ${fromA.toUpperCase()} deposit cannot name a Monero address: the memo would exceed the 80 bytes ${fromA.toUpperCase()} allows. Swap from XMR instead, or use another provider.`,
      );
    }
    if (fromA === 'xmr' && !req.refundAddress) {
      throw swapError('refund_address_required', 'An XMR swap needs a refund address: THORChain cannot see who sent Monero.');
    }

    const avail = await this.availability();
    for (const a of [fromA, toA]) {
      if (!avail[a].available) {
        throw swapError('provider_unavailable', `THORChain ${a.toUpperCase()}: ${avail[a].reason ?? 'unavailable'}.`);
      }
    }

    const amount = toThorUnits(req.fromAmount, SPEC[fromA].decimals);
    if (amount <= 0n) throw swapError('insufficient_amount', 'Amount is too small to swap.');
    const q = new URLSearchParams({
      from_asset: SPEC[fromA].pool,
      to_asset: SPEC[toA].pool,
      amount: amount.toString(),
      tolerance_bps: String(this.toleranceBps),
    });
    if (req.toAddress) q.set('destination', req.toAddress);
    // UTXO deposits refund to the sending address on their own, and adding a
    // refund address there pushes the memo past 80 bytes. Monero has no
    // visible sender, so it is the one chain that must name one.
    if (fromA === 'xmr') q.set('refund_address', req.refundAddress!);
    const aff = this.opts.affiliate;
    if (aff && aff.bps > 0) {
      q.set('affiliate', aff.name);
      q.set('affiliate_bps', String(aff.bps));
    }

    let raw: ThorQuote;
    try {
      raw = await this.get<ThorQuote>(`/thorchain/quote/swap?${q.toString()}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/memo too long/i.test(msg)) {
        throw swapError('asset_pair_unsupported', `The swap instruction does not fit in a ${fromA.toUpperCase()} transaction.`);
      }
      throw e;
    }

    const inbound = raw.inbound_address ?? '';
    if (!inbound || inbound !== avail[fromA].inboundAddress) {
      // The vault rotated between the two calls. Refuse rather than guess.
      this.cached = null;
      throw swapError('quote_expired', 'THORChain changed its deposit address. Get a new quote.');
    }
    if (raw.recommended_min_amount_in !== undefined && amount < BigInt(raw.recommended_min_amount_in)) {
      const min = fromThorUnits(raw.recommended_min_amount_in, SPEC[fromA].decimals);
      throw swapError('insufficient_amount', `THORChain needs at least ${min} atomic units of ${fromA.toUpperCase()} for this swap.`);
    }
    const memo = raw.memo;
    if (req.toAddress) {
      if (!memo) throw swapError('network_error', 'THORChain returned a quote without a swap memo.');
      assertMemo(memo, {
        toAsset: toA,
        destination: req.toAddress,
        ...(fromA === 'xmr' ? { refundAddress: req.refundAddress! } : {}),
        maxBytes: SPEC[fromA].memoMaxBytes,
      });
    }

    const expiresAtMs = Math.min(
      typeof raw.expiry === 'number' ? raw.expiry * 1_000 : Number.POSITIVE_INFINITY,
      this.now() + MAX_QUOTE_LIFETIME_MS,
    );
    const toDec = SPEC[toA].decimals;
    const data: ThorchainQuoteData = {
      provider: 'thorchain',
      fromAsset: fromA,
      toAsset: toA,
      ...(memo && req.toAddress ? { memo, destination: req.toAddress } : {}),
      ...(fromA === 'xmr' ? { refundAddress: req.refundAddress! } : {}),
      inboundAddress: inbound,
      expiresAtMs,
      ...(raw.recommended_min_amount_in !== undefined
        ? { recommendedMinAmountIn: fromThorUnits(raw.recommended_min_amount_in, SPEC[fromA].decimals) }
        : {}),
      fees: {
        total: fromThorUnits(raw.fees?.total ?? '0', toDec),
        affiliate: fromThorUnits(raw.fees?.affiliate ?? '0', toDec),
        outbound: fromThorUnits(raw.fees?.outbound ?? '0', toDec),
        liquidity: fromThorUnits(raw.fees?.liquidity ?? '0', toDec),
      },
      toleranceBps: this.toleranceBps,
    };
    return {
      fromAsset: from,
      toAsset: to,
      fromAmount: req.fromAmount,
      toAmountEstimate: fromThorUnits(raw.expected_amount_out ?? '0', toDec),
      // THORChain charges in the destination asset; the output estimate above
      // is already net of it. The breakdown is in implementationData.fees.
      feeEstimate: '0',
      etaSeconds: raw.total_swap_seconds ?? raw.inbound_confirmation_seconds ?? 0,
      expiresAt: new Date(expiresAtMs),
      kind: 'aggregator',
      implementationData: data,
    };
  }

  /**
   * No trade is created anywhere: THORChain learns of the swap from the
   * deposit itself. This re-checks that the quote can still be honored and
   * returns the vault address and memo for the wallet's send path.
   */
  async start(params: SwapStartParams): Promise<SwapStarted> {
    const data = params.quote.implementationData as ThorchainQuoteData | undefined;
    if (!data || data.provider !== 'thorchain') {
      throw swapError('network_error', 'This quote did not come from THORChain.');
    }
    if (!data.memo || !data.destination) {
      throw swapError('quote_expired', 'Quote again with a destination address before starting.');
    }
    if (params.toAddress && params.toAddress !== data.destination) {
      throw swapError('quote_expired', 'The destination changed after the quote. Get a new quote.');
    }
    await this.preflight(data);
    return {
      id: `thorchain:${randomHex(16)}`,
      depositAddress: data.inboundAddress,
      memo: data.memo,
    };
  }

  /**
   * The check the wallet runs immediately before signing the deposit: the
   * quote has not expired, both chains are still live and unpaused, and the
   * vault address has not rotated. Always asks THORChain fresh.
   */
  async preflight(data: ThorchainQuoteData): Promise<void> {
    if (this.now() >= data.expiresAtMs) {
      throw swapError('quote_expired', 'This THORChain quote has expired. Get a new quote.');
    }
    const avail = await this.availability(true);
    for (const a of [data.fromAsset, data.toAsset]) {
      if (!avail[a].available) {
        throw swapError('provider_unavailable', `THORChain ${a.toUpperCase()}: ${avail[a].reason ?? 'unavailable'}.`);
      }
    }
    if (avail[data.fromAsset].inboundAddress !== data.inboundAddress) {
      throw swapError('quote_expired', 'THORChain changed its deposit address. Get a new quote.');
    }
  }

  /**
   * Status by the deposit's transaction id (THORChain tracks the inbound
   * txid, not an id of ours). The wallet maps its local swap id to the txid
   * it broadcast.
   */
  async status(id: SwapId): Promise<SwapStatus> {
    const txid = id.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      return { state: 'pending', reason: 'awaiting_deposit' };
    }
    return mapStatus(await this.get<ThorTxStatus>(`/thorchain/tx/status/${txid.toUpperCase()}`));
  }

  private async get<T>(path: string): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = this.lastRequestAt + MIN_REQUEST_SPACING_MS - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, { headers: { accept: 'application/json' } });
      } catch (e) {
        throw swapError('network_error', `THORChain is unreachable: ${e instanceof Error ? e.message : String(e)}`);
      }
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        throw swapError('network_error', `THORChain returned an unreadable response (HTTP ${res.status}).`);
      }
      if (!res.ok) {
        const msg = (body as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
        throw swapError('network_error', `THORChain: ${msg}`);
      }
      return body as T;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function isThorAsset(a: string): a is ThorchainAsset {
  return Object.prototype.hasOwnProperty.call(SPEC, a);
}

/** True when the operator policy lets THORChain's live state decide `asset`. */
function policyAllows(policy: ThorchainPolicy, asset: ThorchainAsset): boolean {
  return policy.enabled && (policy.assets?.[asset] ?? DEFAULT_ASSET_POLICY[asset]) !== 'off';
}

function assess(
  asset: ThorchainAsset,
  policy: ThorchainPolicy,
  pools: ThorPool[],
  inbound: ThorInbound[],
): AssetAvailability {
  if (!policy.enabled) return { available: false, reason: 'turned off by this wallet server' };
  if (!policyAllows(policy, asset)) {
    return policy.assets?.[asset] === 'off'
      ? { available: false, reason: 'turned off by this wallet server' }
      : { available: false, reason: 'not yet enabled by this wallet server' };
  }
  const spec = SPEC[asset];
  const pool = Array.isArray(pools) ? pools.find((p) => p.asset === spec.pool) : undefined;
  if (!pool) return { available: false, reason: 'not listed on THORChain' };
  if (pool.status !== 'Available') return { available: false, reason: `pool is ${pool.status.toLowerCase()}` };
  const ib = Array.isArray(inbound) ? inbound.find((x) => x.chain === spec.chain) : undefined;
  if (!ib || !ib.address) return { available: false, reason: 'no deposit address published' };
  if (ib.halted) return { available: false, reason: 'chain is halted' };
  if (ib.global_trading_paused) return { available: false, reason: 'trading is paused network-wide' };
  if (ib.chain_trading_paused) return { available: false, reason: 'trading is paused on this chain' };
  return {
    available: true,
    inboundAddress: ib.address,
    ...(ib.dust_threshold !== undefined ? { dustThreshold: ib.dust_threshold } : {}),
  };
}

/**
 * Refuse a memo that would send the swap somewhere other than asked. The
 * quote API builds the memo; this checks it before the wallet signs it, so a
 * wrong or tampered response cannot redirect funds.
 * Memo shape: `=:ASSET:DEST[/REFUND]:LIMIT[...]`.
 */
export function assertMemo(
  memo: string,
  want: { toAsset: ThorchainAsset; destination: string; refundAddress?: string; maxBytes: number },
): void {
  const bytes = new TextEncoder().encode(memo).length;
  if (bytes > want.maxBytes) {
    throw swapError('asset_pair_unsupported', `Swap memo is ${bytes} bytes; the source chain carries ${want.maxBytes}.`);
  }
  const parts = memo.split(':');
  if (parts.length < 3 || (parts[0] !== '=' && parts[0]!.toUpperCase() !== 'SWAP' && parts[0] !== 's')) {
    throw swapError('network_error', 'THORChain returned something other than a swap memo.');
  }
  const asset = parts[1]!.toUpperCase();
  const shortCodes: Record<ThorchainAsset, string[]> = {
    btc: ['BTC.BTC', 'B'],
    ltc: ['LTC.LTC', 'L'],
    xmr: ['XMR.XMR', 'X'],
  };
  if (!shortCodes[want.toAsset].includes(asset)) {
    throw swapError('network_error', 'The swap memo names a different destination asset.');
  }
  const [dest, refund] = parts[2]!.split('/');
  if (dest !== want.destination) {
    throw swapError('network_error', 'The swap memo names a different destination address.');
  }
  if (want.refundAddress !== undefined && refund !== want.refundAddress) {
    throw swapError('network_error', 'The swap memo is missing the refund address.');
  }
  if (!parts[3] || !/^\d+/.test(parts[3])) {
    throw swapError('network_error', 'The swap memo carries no price limit.');
  }
}

function mapStatus(s: ThorTxStatus): SwapStatus {
  const st = s.stages ?? {};
  if (!st.inbound_observed?.started && !st.inbound_observed?.completed) {
    return { state: 'pending', reason: 'awaiting_deposit' };
  }
  if (!st.inbound_observed?.completed || st.inbound_confirmation_counted?.completed === false || st.inbound_finalised?.completed === false) {
    return { state: 'pending', reason: 'awaiting_confirmations' };
  }
  const zero = /^0+$/;
  const outs = (s.out_txs ?? []).filter((o) => o.id && !zero.test(o.id) && o.chain !== 'THOR');
  const refund = outs.find((o) => /^REFUND:/i.test(o.memo ?? ''));
  if (refund) {
    return { state: 'refunded', refundTxId: refund.id!, reason: 'THORChain refunded the deposit' };
  }
  const paid = outs.find((o) => /^OUT:/i.test(o.memo ?? ''));
  if (paid && st.outbound_signed?.completed !== false) {
    const coin = paid.coins?.[0];
    const dec = CHAIN_DECIMALS[paid.chain ?? ''] ?? 8;
    return { state: 'completed', outboundTxId: paid.id!, toAmount: fromThorUnits(coin?.amount ?? '0', dec) };
  }
  return { state: 'pending', reason: 'in_progress' };
}

/** Native atomic units to THORChain's 1e8 units, rounding down. */
export function toThorUnits(atomic: string, decimals: number): bigint {
  const v = BigInt(atomic);
  if (decimals >= 8) return v / 10n ** BigInt(decimals - 8);
  return v * 10n ** BigInt(8 - decimals);
}

/** THORChain's 1e8 units to native atomic units. */
export function fromThorUnits(units: string, decimals: number): string {
  const v = BigInt(units);
  if (decimals >= 8) return (v * 10n ** BigInt(decimals - 8)).toString();
  return (v / 10n ** BigInt(8 - decimals)).toString();
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function swapError(code: SwapError['code'], message: string): SwapError {
  const err = new Error(message) as SwapError;
  err.code = code;
  return err;
}
