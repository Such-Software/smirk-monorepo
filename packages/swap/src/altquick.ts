/**
 * AltQuick swap client.
 *
 * Why this exists: Smirk's other providers cannot move WOW at all. Trocador
 * answers WOW with "coin not found" and THORChain does not list it. AltQuick's
 * swap product quotes every coin to WOW through its own BTC_WOW order book,
 * which makes it the one hosted route to WOW today. So this provider handles
 * WOW pairs only; Trocador keeps everything else.
 *
 * Two properties of AltQuick shape everything below.
 *
 * Nothing is locked. `POST /trade` takes no amount and returns no quote: the
 * swap fills whatever is deposited, at the book as it stands then, within the
 * pair's `min` and `max`. So a quote here is an estimate with a short expiry,
 * and `quote()` refuses an amount outside the venue's current bounds rather
 * than letting the user deposit into a refund.
 *
 * `/market` reports the top of book and the average only at the maximum size.
 * Estimating a small swap from the max-size average understates it badly: on
 * 2026-09-10 that average was 36 sat per WOW against a 15 sat first rate. So
 * the estimate walks AltQuick's public exchange books the way the swap does:
 * sell the deposit into BTC, take the commission out of the BTC, buy the
 * target. At the maximum size that walk lands within a fraction of a percent
 * of AltQuick's own `ratesWithFees.to.amount`, and below it, which is the
 * direction an estimate should err.
 *
 * AltQuick has no webhooks, so `passthrough` is ignored and status is polled.
 */

import { mustGetAsset, type AssetId } from '@smirk/assets';
import { asSwapError, atomicToDecimal, decimalToAtomicString } from './amounts';
import type {
  QuoteRequest,
  Swap,
  SwapId,
  SwapKind,
  SwapQuote,
  SwapStartParams,
  SwapStarted,
  SwapError,
  SwapStatus,
} from './types';

/** Smirk asset id to AltQuick ticker. Decimals come from @smirk/assets, the one place they are defined. */
const ALTQUICK_TICKER: Record<string, string> = { btc: 'BTC', ltc: 'LTC', xmr: 'XMR', wow: 'WOW' };

function coin(assetId: AssetId): { ticker: string; decimals: number } {
  return { ticker: ALTQUICK_TICKER[assetId]!, decimals: mustGetAsset(assetId).decimals };
}

const WOW: AssetId = 'wow';

/** Rough deposit-to-payout times. AltQuick publishes no confirmation targets. */
const ETA_SECONDS: Record<string, number> = { btc: 3600, ltc: 1800, xmr: 1800, wow: 1800 };

export interface AltQuickSwapOptions {
  /** Default `https://altquick.com`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Sent on `POST /trade`. AltQuick stores an unknown id as null. */
  affiliateId?: string;
  /** Per-request timeout. AltQuick's gateway can hang on an unknown trade id. Default 15 s. */
  timeoutMs?: number;
  /** Swap commission taken from the BTC leg. Default `0.01`, AltQuick's published 1%. */
  commissionRate?: string;
}

export interface AltQuickImplementationData {
  fromCoin: string;
  toCoin: string;
  fromAmountDecimal: string;
  /** The venue's deposit bounds when this quote was made. */
  minDecimal: string;
  maxDecimal: string;
}

interface AltQuickMarket {
  rates?: { to?: { firstrate?: string } };
  min?: string;
  max?: string;
  closed?: boolean;
}

interface AltQuickBook {
  bids?: ReadonlyArray<readonly [string, string] | readonly string[]>;
  asks?: ReadonlyArray<readonly [string, string] | readonly string[]>;
}

interface AltQuickTrade {
  uuid?: string;
  fromAddress?: string;
  toCoin?: string;
  state?: string;
  Deposit?: { state?: string; amount?: string; txid?: string; confirmations?: number };
  Withdraw?: { state?: string; amount?: string; txid?: string };
}

// ---- fixed-point arithmetic ------------------------------------------------
// The walk multiplies prices by quantities across many levels. Floats would
// drift, and a received amount is money, so everything here is an integer
// scaled by 10^18 and rounds down: an estimate may understate, never overstate.

const SCALE = 10n ** 18n;

function toFixed(decimal: string): bigint {
  const s = String(decimal).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw asSwapError('network_error', `AltQuick returned a non-decimal amount: ${s}`);
  }
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole!) * SCALE + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

function fromFixed(x: bigint, decimals: number): string {
  const whole = x / SCALE;
  const frac = (x % SCALE).toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

const mul = (a: bigint, b: bigint) => (a * b) / SCALE;
const div = (a: bigint, b: bigint) => (a * SCALE) / b;

type Level = { price: bigint; qty: bigint };

function levels(rows: AltQuickBook['bids'], descending: boolean): Level[] {
  const out = (rows ?? [])
    .map((r) => ({ price: toFixed(String(r[0])), qty: toFixed(String(r[1])) }))
    .filter((l) => l.price > 0n && l.qty > 0n);
  return out.sort((a, b) => (descending ? Number(b.price - a.price) : Number(a.price - b.price)));
}

/** Spend BTC on a BTC_X book's asks, best first. */
function spendOnAsks(btc: bigint, asks: Level[]): { got: bigint; left: bigint } {
  let got = 0n;
  for (const { price, qty } of asks) {
    const cost = mul(price, qty);
    if (btc >= cost) {
      got += qty;
      btc -= cost;
    } else {
      got += div(btc, price);
      btc = 0n;
      break;
    }
  }
  return { got, left: btc };
}

/** Sell a coin into a BTC_X book's bids, best first. */
function sellIntoBids(qty: bigint, bids: Level[]): { btc: bigint; left: bigint } {
  let btc = 0n;
  for (const level of bids) {
    const take = qty < level.qty ? qty : level.qty;
    btc += mul(take, level.price);
    qty -= take;
    if (qty === 0n) break;
  }
  return { btc, left: qty };
}

export class AltQuickSwap implements Swap {
  readonly kind: SwapKind = 'aggregator';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly commission: bigint;

  constructor(private readonly opts: AltQuickSwapOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://altquick.com').replace(/\/$/, '');
    // Bound here so calls through a stored reference keep `this`.
    const f = opts.fetch ?? globalThis.fetch;
    this.fetchImpl = f.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.commission = toFixed(opts.commissionRate ?? '0.01');
  }

  /** WOW paired with BTC, LTC or XMR, either direction. */
  supports(from: AssetId, to: AssetId): boolean {
    return from !== to && from in ALTQUICK_TICKER && to in ALTQUICK_TICKER && (from === WOW || to === WOW);
  }

  isKnownAsset(assetId: AssetId): boolean {
    return assetId in ALTQUICK_TICKER;
  }

  async quote(req: QuoteRequest): Promise<SwapQuote> {
    if (!this.supports(req.fromAsset, req.toAsset)) {
      throw asSwapError('asset_pair_unsupported', `${req.fromAsset} -> ${req.toAsset}`);
    }
    const from = coin(req.fromAsset);
    const to = coin(req.toAsset);
    const pair = `${from.ticker}-${to.ticker}`;
    const fromAmountDecimal = atomicToDecimal(req.fromAmount, from.decimals);

    const market = await this.getJson<AltQuickMarket | null>(`/swap/api/v1/market/${pair}`);
    if (!market || market.min === undefined || market.max === undefined) {
      throw asSwapError('asset_pair_unsupported', `AltQuick does not quote ${pair}`);
    }
    if (market.closed) {
      throw asSwapError('asset_pair_unsupported', `AltQuick has ${pair} closed right now`);
    }
    const amount = toFixed(fromAmountDecimal);
    if (amount < toFixed(market.min)) {
      throw asSwapError(
        'insufficient_amount',
        `Below AltQuick's minimum of ${market.min} ${from.ticker} for ${pair}`,
      );
    }
    if (amount > toFixed(market.max)) {
      throw asSwapError(
        'amount_above_max',
        `Above AltQuick's current maximum of ${market.max} ${from.ticker}, which is what its book can fill`,
      );
    }

    const received = await this.walk(from.ticker, to.ticker, amount);
    return {
      fromAsset: req.fromAsset,
      toAsset: req.toAsset,
      fromAmount: req.fromAmount,
      toAmountEstimate: decimalToAtomicString(fromFixed(received, to.decimals), to.decimals),
      // Commission only. The price the book fills at is already in the estimate.
      feeEstimate: decimalToAtomicString(fromFixed(mul(amount, this.commission), from.decimals), from.decimals),
      etaSeconds: ETA_SECONDS[req.fromAsset] ?? 1800,
      // Nothing is locked, and a thin book moves; re-quote rather than trust an old one.
      expiresAt: new Date(Date.now() + 60_000),
      kind: this.kind,
      implementationData: {
        fromCoin: from.ticker,
        toCoin: to.ticker,
        fromAmountDecimal,
        minDecimal: market.min,
        maxDecimal: market.max,
      } satisfies AltQuickImplementationData,
    };
  }

  /**
   * Begin the swap. AltQuick allocates a deposit address and fills whatever
   * arrives there. Requires `toAddress` and `refundAddress`: the refund address
   * is AltQuick's `emergencyAddress`, where a deposit it cannot fill goes back.
   */
  async start(params: SwapStartParams): Promise<SwapStarted> {
    const impl = params.quote.implementationData as AltQuickImplementationData | null;
    if (!impl || !impl.fromCoin || !impl.toCoin) {
      throw asSwapError(
        'network_error',
        'Quote is missing AltQuick implementationData; was it produced by AltQuickSwap.quote()?',
      );
    }
    if (!params.toAddress) {
      throw asSwapError('not_implemented', 'AltQuick.start requires `toAddress`, where the swap output lands.');
    }
    if (params.toAddress.length < 30) {
      throw asSwapError('not_implemented', 'AltQuick rejects a `toAddress` shorter than 30 characters.');
    }
    if (!params.refundAddress) {
      throw asSwapError(
        'not_implemented',
        'AltQuick.start requires `refundAddress`; AltQuick returns an unfillable deposit there.',
      );
    }
    const body: Record<string, string> = {
      fromCoin: impl.fromCoin,
      toCoin: impl.toCoin,
      toAddress: params.toAddress,
      emergencyAddress: params.refundAddress,
    };
    if (this.opts.affiliateId) body.affiliateId = this.opts.affiliateId;

    const trade = await this.postJson<AltQuickTrade>('/swap/api/v1/trade', body);
    if (!trade.uuid || !trade.fromAddress) {
      throw asSwapError('network_error', 'AltQuick /trade returned no trade id or no deposit address');
    }
    return { id: trade.uuid, depositAddress: trade.fromAddress };
  }

  async status(id: SwapId): Promise<SwapStatus> {
    const trade = await this.getJson<AltQuickTrade | null>(`/swap/api/v1/trade/${encodeURIComponent(id)}`);
    if (!trade) {
      throw asSwapError('network_error', `AltQuick /trade returned no body for ${id}`);
    }
    return mapStatus(trade);
  }

  // ---- internals ------------------------------------------------------------

  /** What `amount` of `fromTicker` buys of `toTicker`, walking the live books. */
  private async walk(fromTicker: string, toTicker: string, amount: bigint): Promise<bigint> {
    const [fromBook, toBook] = await Promise.all([
      fromTicker === 'BTC' ? null : this.getJson<AltQuickBook>(`/api/v2/orderbook/BTC_${fromTicker}`),
      toTicker === 'BTC' ? null : this.getJson<AltQuickBook>(`/api/v2/orderbook/BTC_${toTicker}`),
    ]);
    let btc = amount;
    if (fromBook) {
      const sold = sellIntoBids(amount, levels(fromBook.bids, true));
      if (sold.left > 0n) {
        throw asSwapError('amount_above_max', `AltQuick's ${fromTicker} book cannot absorb this deposit right now`);
      }
      btc = sold.btc;
    }
    btc -= mul(btc, this.commission);
    if (!toBook) return btc;
    const bought = spendOnAsks(btc, levels(toBook.asks, false));
    if (bought.left > 0n) {
      throw asSwapError('amount_above_max', `AltQuick's ${toTicker} book cannot fill this swap right now`);
    }
    return bought.got;
  }

  /**
   * Run one request, body included, against a timer.
   *
   * The timer races the work instead of only aborting it. An abort signal is a
   * request, not a guarantee: an injected fetch (the desktop's native one, or a
   * test stub) may ignore it, and AltQuick's gateway can hang outright on an
   * unknown trade id. A server that sends headers and then stalls the body is
   * caught the same way, because reading the body is inside the race.
   */
  private async withTimeout<T>(path: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(asSwapError('network_error', `AltQuick ${path}: timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([work(controller.signal), expired]);
    } catch (e) {
      if ((e as SwapError).code) throw e;
      throw asSwapError('network_error', `AltQuick ${path}: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private getJson<T>(path: string): Promise<T> {
    return this.withTimeout(path, async (signal) => {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { Accept: 'application/json' },
        signal,
      });
      return this.parse<T>(path, res);
    });
  }

  private postJson<T>(path: string, body: unknown): Promise<T> {
    return this.withTimeout(path, async (signal) => {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      return this.parse<T>(path, res);
    });
  }

  private async parse<T>(path: string, res: Response): Promise<T> {
    const text = await res.text();
    if (res.status === 422) {
      let fields = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as { errors?: Record<string, string> };
        if (parsed.errors) fields = Object.values(parsed.errors).join('; ');
      } catch {
        // Keep the raw text.
      }
      throw asSwapError('network_error', `AltQuick refused ${path}: ${fields}`);
    }
    if (!res.ok) {
      throw asSwapError('network_error', `AltQuick ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    // An unknown market answers 200 with an empty body.
    if (!text.trim()) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw asSwapError('network_error', `AltQuick ${path} returned something other than JSON`);
    }
  }
}

function tickerDecimals(ticker: string | undefined): number {
  const id = Object.keys(ALTQUICK_TICKER).find((k) => ALTQUICK_TICKER[k] === ticker);
  return id ? mustGetAsset(id).decimals : 8;
}

function mapStatus(t: AltQuickTrade): SwapStatus {
  switch (t.state) {
    case 'awaitingDeposit':
      // The top-level state stays here until the end; progress is in the
      // nested records, which appear only once each step exists.
      if (!t.Deposit) return { state: 'pending', reason: 'awaiting_deposit' };
      if (t.Deposit.state !== 'depositConfirmed') return { state: 'pending', reason: 'awaiting_confirmations' };
      return { state: 'pending', reason: 'in_progress' };
    case 'tradeComplete':
      return {
        state: 'completed',
        outboundTxId: t.Withdraw?.txid ?? '',
        toAmount: decimalToAtomicString(t.Withdraw?.amount ?? '0', tickerDecimals(t.toCoin)),
      };
    case 'refunded':
      // AltQuick publishes no refund txid; the UI says "returned to your refund address".
      return { state: 'refunded', refundTxId: '', reason: 'AltQuick returned the deposit' };
    default:
      return { state: 'failed', reason: `Unknown AltQuick state: ${t.state ?? '(none)'}` };
  }
}
