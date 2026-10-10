/**
 * NonLogs external-wallet swaps, through our backend.
 *
 * Non-custodial for the user in the same sense as a normal send: the wallet
 * pays a NonLogs deposit address from its own keys, and NonLogs pays the
 * other coin to the wallet's own address, refunding to the wallet's own
 * address if it cannot. NonLogs signs every private call with an HMAC secret
 * that cannot ship in a wallet, so quotes, creation and status go through our
 * backend (`/swaps/nonlogs/*`), which holds the key and never touches funds.
 * Order books come through the backend too, cached, so the user's IP never
 * reaches NonLogs.
 *
 * WHAT THE USER IS SHOWN, AND WHY
 * -------------------------------
 * NonLogs' quote is an estimate: it reserves no address, price or liquidity,
 * prices float until execution, matching can wait up to 12 hours, and a
 * partial fill pays part out and refunds the rest. So every quote is paired
 * with a walk of the live order books for each leg of the route (see
 * `./orderbook`): the expected receipt after fees, the price impact against
 * the mid price, and the most the visible books can fill. When the two
 * estimates disagree materially, both are shown.
 *
 * GRIN
 * ----
 * Not offered in-app. A Grin deposit to an exchange is an interactive
 * slatepack exchange, not a payment to an address, and NonLogs' external-swap
 * API returns a deposit address. Until NonLogs documents a Grin deposit this
 * wallet can complete on its own, GRIN stays in the "where to trade" panel.
 */

import type { AssetId } from '@smirk/assets';
import type {
  QuoteRequest,
  Swap,
  SwapError,
  SwapId,
  SwapKind,
  SwapQuote,
  SwapStartParams,
  SwapStarted,
  SwapStatus,
} from './types';
import {
  dec,
  depthWarning,
  fmt,
  legsFromPairs,
  materiallyDifferent,
  planRoute,
  walkRoute,
  type DepthWarning,
  type Dec,
  type OrderBook,
  type RouteResult,
} from './orderbook';

/** Assets this provider routes in-app. GRIN is excluded; see the header. */
export type NonlogsAsset = 'btc' | 'ltc' | 'xmr' | 'wow';

const SPEC: Readonly<Record<NonlogsAsset, { symbol: string; network: string; decimals: number }>> = {
  btc: { symbol: 'BTC', network: 'bitcoin', decimals: 8 },
  ltc: { symbol: 'LTC', network: 'litecoin', decimals: 8 },
  xmr: { symbol: 'XMR', network: 'monero', decimals: 12 },
  wow: { symbol: 'WOW', network: 'wownero', decimals: 11 },
};

/** Markets NonLogs lists for our coins, used to plan a route when a quote
 *  does not report one. An absent or empty book simply fills nothing. */
export const NONLOGS_MARKETS: ReadonlySet<string> = new Set([
  'WOW-BTC',
  'WOW-XMR',
  'WOW-USDT',
  'GRIN-BTC',
  'GRIN-XMR',
  'LTC-BTC',
  'LTC-XMR',
  'XMR-BTC',
  'XMR-USDT',
  'BTC-USDT',
]);

/** NonLogs' published taker fee per fulfilled order (0.15 percent). */
export const NONLOGS_TAKER_FEE = '0.0015';
/** NonLogs' convenience fee on external swaps (0.8 percent). */
export const NONLOGS_CONVENIENCE_FEE = '0.008';

/** What the backend proxy offers. `api` calls resolve to the JSON body, or
 *  throw a `NonlogsBackendError` carrying the backend's code. */
export interface NonlogsBackend {
  assets(): Promise<unknown>;
  quote(body: Record<string, string>): Promise<unknown>;
  create(body: Record<string, string>): Promise<unknown>;
  status(id: string): Promise<unknown>;
  orderbook(pair: string): Promise<unknown>;
}

export class NonlogsBackendError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = 'NonlogsBackendError';
  }
}

/** The order-book reading shown beside a quote. JSON-safe (strings and
 *  numbers only), because it is persisted with the quote in wizard state. */
export interface BookAnalysis {
  /** Pair symbols walked, in order, e.g. `["GRIN-BTC", "WOW-BTC"]`. */
  route: string[];
  /** Expected receipt after modelled fees, decimal, in the output coin. */
  expectedReceive: string;
  /** Output from the books before fees. */
  grossReceive: string;
  /** Price impact against the mid price, as a fraction; null without a mid. */
  priceImpact: number | null;
  /** Largest input the visible books fill completely, decimal, input coin. */
  maxInput: string;
  /** The order is larger than the visible books. */
  exceedsDepth: boolean;
  warning: DepthWarning;
  /** NonLogs' own estimate, decimal, when the quote carried one. */
  venueEstimate: string | null;
  /** The two estimates differ by more than 2 percent. */
  estimatesDiffer: boolean;
  /** Fees modelled in the book estimate, in words. */
  feesModelled: string;
}

export interface NonlogsQuoteData {
  provider: 'nonlogs';
  from: NonlogsAsset;
  to: NonlogsAsset;
  /** Decimal amount sent to NonLogs, as quoted. */
  amount: string;
  fromNetwork: string;
  toNetwork: string;
  /** Generated at quote time and persisted with the quote, so every retry of
   *  the same swap reuses it and NonLogs answers with the same swap. */
  clientRequestId: string;
  analysis: BookAnalysis | null;
  /** The quote's limits, decimal, when NonLogs reported them. */
  minimum: string | null;
  maximum: string | null;
}

export interface NonlogsStarted extends SwapStarted {
  /** NonLogs' private status page. A bearer link: show it to the user, never
   *  log it or send it anywhere else. */
  statusUrl?: string;
  /** Unix ms when the 24-hour funding window closes. */
  fundingExpiresAtMs?: number;
}

export interface NonlogsSwapOptions {
  backend: NonlogsBackend;
  /** Fresh UUIDs for request ids. Defaults to `crypto.randomUUID`. */
  randomUUID?: () => string;
  now?: () => number;
}

/** How long the wallet treats a quote as current: NonLogs reserves nothing,
 *  so a short window keeps the shown numbers close to the book. */
const QUOTE_LIFETIME_MS = 2 * 60_000;
/** Matching may wait up to 12 hours after the deposit is spendable. */
const ETA_SECONDS = 60 * 60;

export class NonlogsSwap implements Swap {
  readonly kind: SwapKind = 'aggregator';
  private readonly backend: NonlogsBackend;
  private readonly uuid: () => string;
  private readonly now: () => number;
  private networks: Partial<Record<string, string>> | null = null;

  constructor(opts: NonlogsSwapOptions) {
    this.backend = opts.backend;
    this.uuid = opts.randomUUID ?? (() => globalThis.crypto.randomUUID());
    this.now = opts.now ?? (() => Date.now());
  }

  supports(from: AssetId, to: AssetId): boolean {
    return from !== to && from in SPEC && to in SPEC;
  }

  /** Which of our coins NonLogs reports swappable now. */
  async availableAssets(): Promise<NonlogsAsset[]> {
    const raw = await this.backend.assets();
    const listed = swappable(raw);
    this.networks = listed.networks;
    return (Object.keys(SPEC) as NonlogsAsset[]).filter((a) => listed.symbols.has(SPEC[a].symbol));
  }

  async quote(req: QuoteRequest): Promise<SwapQuote> {
    const from = asAsset(req.fromAsset);
    const to = asAsset(req.toAsset);
    if (!from || !to || from === to) {
      throw swapError('asset_pair_unsupported', 'NonLogs swaps in this wallet cover BTC, LTC, XMR and WOW.');
    }
    const amount = atomicToDecimal(req.fromAmount, SPEC[from].decimals);
    if (amount === '0') throw swapError('insufficient_amount', 'Enter an amount to swap.');
    const fromNetwork = this.networks?.[SPEC[from].symbol] ?? SPEC[from].network;
    const toNetwork = this.networks?.[SPEC[to].symbol] ?? SPEC[to].network;
    const raw = await this.call(() =>
      this.backend.quote({
        from: SPEC[from].symbol,
        to: SPEC[to].symbol,
        amount,
        from_network: fromNetwork,
        to_network: toNetwork,
      }),
    );
    const venueEstimate = pickDecimal(raw, ESTIMATE_KEYS);
    const networkFee = networkFeeIn(raw, SPEC[to].symbol);
    const analysis = await this.analyse(from, to, amount, routeOf(raw), venueEstimate, networkFee);

    const estimate =
      venueEstimate !== null
        ? decimalToAtomic(venueEstimate, SPEC[to].decimals)
        : analysis
          ? decimalToAtomic(analysis.expectedReceive, SPEC[to].decimals)
          : '0';
    if (estimate === '0' && (!analysis || analysis.exceedsDepth)) {
      throw swapError('provider_unavailable', 'NonLogs has no liquidity for this pair right now.');
    }
    const minimum = pickDecimal(raw, MIN_KEYS);
    const maximum = pickDecimal(raw, MAX_KEYS);
    const data: NonlogsQuoteData = {
      provider: 'nonlogs',
      from,
      to,
      amount,
      fromNetwork,
      toNetwork,
      clientRequestId: this.uuid(),
      analysis,
      minimum,
      maximum,
    };
    return {
      fromAsset: req.fromAsset,
      toAsset: req.toAsset,
      fromAmount: req.fromAmount,
      toAmountEstimate: estimate,
      feeEstimate: modelledFeeAtomic(req.fromAmount, analysis?.route.length ?? 1),
      etaSeconds: ETA_SECONDS,
      expiresAt: new Date(this.now() + QUOTE_LIFETIME_MS),
      kind: this.kind,
      implementationData: data,
    };
  }

  /**
   * Create the swap. `toAddress` and `refundAddress` must be the wallet's own;
   * the caller enforces that, since only it knows the wallet's addresses.
   * Retrying with the same quote reuses its request id: the same swap and
   * deposit address come back, never a second swap.
   */
  async start(params: SwapStartParams): Promise<NonlogsStarted> {
    const data = params.quote.implementationData as NonlogsQuoteData | null;
    if (!data || data.provider !== 'nonlogs') {
      throw swapError('not_implemented', 'This quote is not a NonLogs quote. Get a new quote.');
    }
    if (!params.toAddress) throw swapError('not_implemented', 'A payout address is required.');
    if (!params.refundAddress) throw swapError('refund_address_required', 'A refund address is required.');
    const raw = await this.call(() =>
      this.backend.create({
        from: SPEC[data.from].symbol,
        to: SPEC[data.to].symbol,
        amount: data.amount,
        from_network: data.fromNetwork,
        to_network: data.toNetwork,
        payout_address: params.toAddress!,
        refund_address: params.refundAddress!,
        client_request_id: data.clientRequestId,
      }),
    );
    const id = pickString(raw, ['id']) ?? pickNumberString(raw, ['id']);
    const deposit = pickString(raw, ['deposit_address']);
    if (!id || !deposit) {
      throw swapError('network_error', 'NonLogs did not return a deposit address. Try again: the same swap comes back.');
    }
    const tag = pickString(raw, ['address_tag']);
    if (tag) {
      // None of our coins uses a destination tag, and a deposit sent without
      // one it needs is lost. Refuse rather than guess.
      throw swapError('provider_unavailable', 'NonLogs asked for a deposit tag this wallet cannot add.');
    }
    const statusUrl = pickString(raw, ['swap_url']);
    const expires = pickString(raw, ['funding_expires_at']);
    const expiresMs = expires ? Date.parse(expires) : NaN;
    return {
      id,
      depositAddress: deposit,
      ...(statusUrl && statusUrl.startsWith('https://') ? { statusUrl } : {}),
      ...(Number.isFinite(expiresMs) ? { fundingExpiresAtMs: expiresMs } : {}),
    };
  }

  /** Status without knowing the output coin: a completed swap's amount is '0'.
   *  Prefer `statusFor`, which reports the payout in atomic units. */
  async status(id: SwapId): Promise<SwapStatus> {
    const raw = await this.call(() => this.backend.status(id));
    return mapStatus(raw, this.now(), null);
  }

  /** Status with the payout in the output coin's atomic units. */
  async statusFor(id: SwapId, toAsset: AssetId): Promise<SwapStatus> {
    const raw = await this.call(() => this.backend.status(id));
    const to = asAsset(toAsset);
    return mapStatus(raw, this.now(), to ? SPEC[to].decimals : null);
  }

  /** Walk the books for the route, or plan one. Null when nothing can be read. */
  private async analyse(
    from: NonlogsAsset,
    to: NonlogsAsset,
    amount: string,
    reported: string[] | null,
    venueEstimate: string | null,
    networkFee: Dec,
  ): Promise<BookAnalysis | null> {
    const F = SPEC[from].symbol;
    const T = SPEC[to].symbol;
    const legs = (reported ? legsFromPairs(F, reported) : null) ?? planRoute(F, T, NONLOGS_MARKETS, ['BTC', 'XMR']);
    if (!legs || legs[legs.length - 1]!.to !== T) return null;
    const books = new Map<string, OrderBook>();
    for (const leg of legs) {
      try {
        books.set(leg.pair, toBook(leg.pair, await this.backend.orderbook(leg.pair)));
      } catch {
        // A book that cannot be read counts as empty: it fills nothing.
        books.set(leg.pair, { pair: leg.pair, bids: [], asks: [] });
      }
    }
    let r: RouteResult;
    try {
      r = walkRoute(legs, books, dec(amount), {
        takerFee: dec(NONLOGS_TAKER_FEE),
        convenienceFee: dec(NONLOGS_CONVENIENCE_FEE),
        networkFeeOut: networkFee,
      });
    } catch {
      return null;
    }
    const decimalsOut = SPEC[to].decimals;
    const expected = fmt(r.expectedOut, decimalsOut);
    return {
      route: legs.map((l) => l.pair),
      expectedReceive: expected,
      grossReceive: fmt(r.grossOut, decimalsOut),
      priceImpact: r.impact,
      maxInput: fmt(r.maxInput, SPEC[from].decimals),
      exceedsDepth: r.exceedsDepth,
      warning: depthWarning(r),
      venueEstimate,
      estimatesDiffer: venueEstimate !== null && materiallyDifferent(dec(venueEstimate), r.expectedOut),
      feesModelled:
        `0.15% taker per leg (${legs.length}), 0.8% convenience fee` +
        (networkFee > 0n ? ', and the quoted network fee' : '; network fee not included'),
    };
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toSwapError(e);
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing. NonLogs' JSON is read leniently: the docs name fields but not
// every shape, so each read tries the plausible keys and falls back to null.
// ---------------------------------------------------------------------------

const ESTIMATE_KEYS = ['estimated_receive', 'estimated_receipt', 'estimated_amount', 'receive_amount', 'to_amount', 'estimate'];
const MIN_KEYS = ['minimum', 'min_amount', 'minimum_amount'];
const MAX_KEYS = ['maximum', 'max_amount', 'maximum_amount'];

function asAsset(a: string): NonlogsAsset | null {
  return a in SPEC ? (a as NonlogsAsset) : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pickString(v: unknown, keys: string[]): string | null {
  const o = obj(v);
  for (const k of keys) {
    const x = o[k];
    if (typeof x === 'string' && x.length > 0) return x;
  }
  return null;
}

function pickNumberString(v: unknown, keys: string[]): string | null {
  const o = obj(v);
  for (const k of keys) {
    const x = o[k];
    if (typeof x === 'number' && Number.isInteger(x)) return String(x);
  }
  return null;
}

const DECIMAL = /^\d+(\.\d+)?$/;

/** A decimal string from the first matching key, directly or as `{amount}`. */
function pickDecimal(v: unknown, keys: string[]): string | null {
  const o = obj(v);
  for (const k of keys) {
    const x = o[k];
    if (typeof x === 'string' && DECIMAL.test(x)) return x;
    const inner = obj(x)['amount'];
    if (typeof inner === 'string' && DECIMAL.test(inner)) return inner;
  }
  return null;
}

/** The route as pair symbols, from `route` as strings or `{pair}` objects. */
function routeOf(v: unknown): string[] | null {
  const r = obj(v)['route'];
  if (!Array.isArray(r)) return null;
  const pairs = r
    .map((x) => (typeof x === 'string' ? x : pickString(x, ['pair', 'symbol', 'market'])))
    .filter((x): x is string => !!x && /^[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(x));
  return pairs.length === r.length && pairs.length > 0 ? pairs.map((p) => p.toUpperCase()) : null;
}

/** Sum of network fee entries denominated in the output coin. */
function networkFeeIn(v: unknown, symbol: string): Dec {
  const fees = obj(v)['fees'];
  if (!Array.isArray(fees)) return 0n;
  let total = 0n;
  for (const f of fees) {
    const o = obj(f);
    const kind = String(o['kind'] ?? o['type'] ?? o['name'] ?? '').toLowerCase();
    const sym = String(o['symbol'] ?? o['asset'] ?? '').toUpperCase();
    const amt = o['amount'];
    if (kind.includes('network') && sym === symbol && typeof amt === 'string' && DECIMAL.test(amt)) {
      total += dec(amt);
    }
  }
  return total;
}

function toBook(pair: string, raw: unknown): OrderBook {
  const o = obj(raw);
  const side = (x: unknown) =>
    Array.isArray(x)
      ? x.filter(
          (l): l is [string, string] =>
            Array.isArray(l) && typeof l[0] === 'string' && typeof l[1] === 'string',
        )
      : [];
  return { pair, bids: side(o['bids']), asks: side(o['asks']) };
}

/**
 * The object holding NonLogs' asset catalogue. The API docs put
 * `creation_enabled` and `assets` at the top; NonLogs' own guest-swap catalogue
 * nests them under `swap` with the flag named `enabled`. Accept both, and a
 * `data` or `result` envelope, so a wrapped body does not read as "no coins".
 */
function catalogueRoot(o: Record<string, unknown>): Record<string, unknown> | null {
  if (Array.isArray(o['assets'])) return o;
  for (const k of ['swap', 'data', 'result']) {
    const inner = obj(o[k]);
    if (Array.isArray(inner['assets'])) return inner;
  }
  return null;
}

/** Symbols NonLogs lists as swappable, and each one's first network. Closed
 *  unless an explicit `true` creation flag is present, under either name. */
export function swappable(raw: unknown): { symbols: Set<string>; networks: Record<string, string> } {
  const o = obj(raw);
  const symbols = new Set<string>();
  const networks: Record<string, string> = {};
  const root = catalogueRoot(o);
  if (!root) return { symbols, networks };
  const open = [root, o].some((x) => x['creation_enabled'] === true || x['enabled'] === true);
  if (!open) return { symbols, networks };
  const assets = root['assets'] as unknown[];
  for (const a of assets) {
    const e = obj(a);
    const symbol = typeof e['symbol'] === 'string' ? e['symbol'].toUpperCase() : null;
    if (!symbol) continue;
    // Coins NonLogs cannot swap address-only (Grin, Beam) are `supported: false`.
    if (e['supported'] === false) continue;
    const flags = [e['available'], e['enabled'], e['swap_enabled']].filter((x) => typeof x === 'boolean');
    if (flags.length > 0 && flags[0] === false) continue;
    symbols.add(symbol);
    if (typeof e['network'] === 'string' && !networks[symbol]) networks[symbol] = e['network'];
  }
  return { symbols, networks };
}

/**
 * Map NonLogs' swap projection onto the wallet's status union. A payout
 * means completed, even when part of the deposit was refunded (a partial
 * fill); `toAmount` is in atomic units of the output coin when `toDecimals`
 * is known, otherwise '0'.
 */
export function mapStatus(raw: unknown, nowMs: number, toDecimals: number | null): SwapStatus {
  const o = obj(raw);
  const list = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).map(obj) : []);
  const payouts = list('payouts').filter((p) => typeof p['tx_hash'] === 'string' && p['tx_hash']);
  const refunds = list('refunds').filter((r) => typeof r['tx_hash'] === 'string' && r['tx_hash']);
  const payments = list('payments');
  if (payouts.length > 0) {
    const total = payouts
      .map((p) => (typeof p['amount'] === 'string' ? p['amount'] : '0'))
      .reduce((a, b) => a + (DECIMAL.test(b) ? dec(b) : 0n), 0n);
    const toAmount = toDecimals === null ? '0' : decimalToAtomic(fmt(total, 18), toDecimals);
    return { state: 'completed', outboundTxId: String(payouts[0]!['tx_hash']), toAmount };
  }
  if (refunds.length > 0) {
    return {
      state: 'refunded',
      refundTxId: String(refunds[0]!['tx_hash']),
      reason: 'NonLogs could not swap the deposit and returned it to your refund address.',
    };
  }
  if (payments.length === 0) {
    const expires = typeof o['funding_expires_at'] === 'string' ? Date.parse(o['funding_expires_at']) : NaN;
    if (Number.isFinite(expires) && nowMs > expires) {
      return { state: 'failed', reason: 'The 24-hour funding window closed with no deposit received. Nothing was spent.' };
    }
    return { state: 'pending', reason: 'awaiting_deposit' };
  }
  const confirming = payments.some((p) => {
    const have = Number(p['confirmations']);
    const need = Number(p['required_confirmations'] ?? p['confirmations_required']);
    return Number.isFinite(have) && Number.isFinite(need) && have < need;
  });
  return { state: 'pending', reason: confirming ? 'awaiting_confirmations' : 'in_progress' };
}

/** Atomic integer string to a trimmed decimal string. */
export function atomicToDecimal(atomic: string, decimals: number): string {
  if (!/^\d+$/.test(atomic)) throw swapError('insufficient_amount', 'Amount must be a whole number of atomic units.');
  const v = BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const int = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : `${int}`;
}

/** Decimal string to atomic units, truncating extra precision. */
export function decimalToAtomic(decimal: string, decimals: number): string {
  if (!DECIMAL.test(decimal)) return '0';
  const [int, frac = ''] = decimal.split('.');
  return (BigInt(int!) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
}

/** The modelled fee share of the input, for the quote's fee line. */
function modelledFeeAtomic(fromAtomic: string, legs: number): string {
  const v = BigInt(fromAtomic);
  // 1 - (1 - 0.0015)^legs * (1 - 0.008), in parts per million.
  let keep = 1_000_000n;
  for (let i = 0; i < legs; i++) keep = (keep * 998_500n) / 1_000_000n;
  keep = (keep * 992_000n) / 1_000_000n;
  return ((v * (1_000_000n - keep)) / 1_000_000n).toString();
}

function toSwapError(e: unknown): SwapError {
  if (e instanceof NonlogsBackendError) {
    switch (e.code) {
      case 'SWAP_UNCERTAIN':
        return swapError(
          'network_error',
          'NonLogs did not confirm the swap. Confirm again: the same swap comes back, never a second one.',
        );
      case 'SWAP_REJECTED':
        return swapError('asset_pair_unsupported', 'NonLogs cannot swap this pair or amount right now.');
      case 'SWAP_PAUSED':
        return swapError('provider_unavailable', 'NonLogs has paused new swaps. Try again later.');
      case 'RATE_LIMITED':
        return swapError('network_error', 'Too many swap requests. Wait a moment and try again.');
      case 'NOT_FOUND':
        return swapError('provider_unavailable', 'NonLogs swaps are not offered by this wallet server.');
      default:
        return swapError('network_error', e.message || 'NonLogs is unavailable right now.');
    }
  }
  if (e && typeof e === 'object' && 'code' in e && typeof (e as SwapError).code === 'string') return e as SwapError;
  return swapError('network_error', e instanceof Error ? e.message : 'NonLogs is unavailable right now.');
}

function swapError(code: SwapError['code'], message: string): SwapError {
  const err = new Error(message) as SwapError;
  err.code = code;
  return err;
}
