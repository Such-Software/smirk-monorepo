/**
 * Trocador CEX-aggregator swap implementation.
 *
 * Client-direct (the wallet talks straight to `api.trocador.app`) per
 * the v0.3 architecture decision — Smirk's backend does **not** proxy
 * swap traffic, so we never end up as the money-transmitter in the
 * flow. The backend hosts only a webhook receiver for status pings
 * (`POST /api/v1/webhook/trocador`) plus a `swaps` table the
 * extension can read through `GET /api/v1/swaps/:tradeId`. Trocador
 * itself custodies funds during the swap; Smirk just builds the
 * request and shows the user the deposit address to send to.
 *
 * The affiliate API key ships in the extension bundle. Per the
 * 2026-05-14 architecture call, this is an explicit risk-accepted
 * tradeoff: a leaked affiliate key affects rev-share, not custody
 * (Trocador's classification is "affiliate" not "bearer credential"),
 * and a server-side proxy would push Smirk into a money-transmitter
 * posture the team has chosen to avoid. See `docs/V0_3_PLAN.md`
 * Decision 2.
 *
 * Reference: Cake Wallet's `trocador_exchange_provider.dart` for
 * field-name parity; endpoints validated against `api.trocador.app`
 * directly during integration.
 */

import type { AssetId } from '@smirk/assets';
import type {
  AtomicAmount,
  QuoteRequest,
  Swap,
  SwapError,
  SwapId,
  SwapKind,
  SwapQuote,
  SwapStarted,
  SwapStatus,
} from './types';

/** Maps a Smirk asset id to the (ticker, network) pair Trocador expects. */
const TROCADOR_COIN: Record<string, { ticker: string; network: string; decimals: number }> = {
  btc: { ticker: 'btc', network: 'Mainnet', decimals: 8 },
  ltc: { ticker: 'ltc', network: 'Mainnet', decimals: 8 },
  xmr: { ticker: 'xmr', network: 'Mainnet', decimals: 12 },
  wow: { ticker: 'wow', network: 'Mainnet', decimals: 11 },
  grin: { ticker: 'grin', network: 'Mainnet', decimals: 9 },
};

/** Lifecycle states Trocador reports on `/trade` responses. Mirrored
 *  verbatim from their API so we can pattern-match without rewrites. */
type TrocadorStatus =
  | 'new'
  | 'waiting'
  | 'confirming'
  | 'exchanging'
  | 'sending'
  | 'finished'
  | 'refunded'
  | 'expired'
  | 'error';

interface TrocadorQuotesEntry {
  provider: string;
  amount_to: string;
  unadjusted_amount_to: number;
  eta: number;
  kycrating: string;
  logpolicy: string;
  insurance: number;
  fixed: string;
  waste: string;
  amount_to_USD: string;
  amount_from_USD: string;
  USD_total_cost_percentage: string;
  provider_logo: string;
}

interface TrocadorRateResponse {
  trade_id: string;
  date: string;
  ticker_from: string;
  ticker_to: string;
  coin_from: string;
  coin_to: string;
  network_from: string;
  network_to: string;
  amount_from: number;
  amount_to: number;
  provider: string;
  fixed: boolean;
  payment: boolean;
  status: TrocadorStatus;
  quotes: { quotes: TrocadorQuotesEntry[]; markup?: boolean };
}

interface TrocadorTradeResponse extends TrocadorRateResponse {
  address_provider: string;
  address_provider_memo: string;
  address_user: string;
  address_user_memo: string;
  refund_address: string;
  refund_address_memo: string;
  password: string;
  id_provider: string;
}

/** Stored in `SwapQuote.implementationData` between `quote()` and
 *  `start()`. Picked provider + trade_id let `start()` finalize the
 *  same draft without re-quoting (and risking a stale rate). */
interface TrocadorImplementationData {
  tradeId: string;
  provider: string;
  amountFromDecimal: string;
  amountToDecimal: string;
}

export interface TrocadorSwapOptions {
  /** Affiliate API key from Trocador. */
  apiKey: string;
  /** Override the API base. Defaults to `https://api.trocador.app`. */
  baseUrl?: string;
  /**
   * Optional webhook URL Trocador pings on status changes. When set,
   * the wallet's poll cadence in `status()` can be relaxed because
   * the backend learns of state changes via push. The webhook URL is
   * **your** server — Trocador will POST `{trade_id, status, ...}`
   * to it whenever the swap moves.
   */
  webhookUrl?: string;
  /**
   * Optional caller-side correlation id that Trocador echoes back on
   * the webhook. Lets the backend match an inbound webhook to the
   * `swaps` row it persisted for this trade.
   */
  passthrough?: string;
  /**
   * Trocador's `markup` parameter — passed verbatim. Affects the
   * affiliate rev-share, not the user's quoted rate. Default is the
   * empty string (no markup). Configure per Trocador's onboarding
   * email if you have a specific commission split set up.
   */
  markup?: string;
  /**
   * Minimum KYC rating to include in the quote candidate set. `C` is
   * Trocador's default (excludes the lowest-rated providers); `A` is
   * the strictest. Smirk defaults to `C` matching Cake Wallet's
   * production setting.
   */
  minKycRating?: 'A' | 'B' | 'C';
  /** `fetch` impl. Defaults to `globalThis.fetch`. Injectable for
   *  tests and for non-browser runtimes. */
  fetch?: typeof fetch;
}

export class TrocadorSwap implements Swap {
  readonly kind: SwapKind = 'aggregator';

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minKycRating: 'A' | 'B' | 'C';
  private readonly markup: string;

  constructor(private readonly opts: TrocadorSwapOptions) {
    if (!opts.apiKey) {
      throw new Error('TrocadorSwap requires an apiKey');
    }
    this.baseUrl = opts.baseUrl ?? 'https://api.trocador.app';
    // Bind in the constructor so individual calls don't lose `this` on
    // the global fetch in service-worker contexts.
    const f = opts.fetch ?? globalThis.fetch;
    this.fetchImpl = f.bind(globalThis);
    this.minKycRating = opts.minKycRating ?? 'C';
    this.markup = opts.markup ?? '';
  }

  /** All Smirk-supported assets are nominally on Trocador, but live
   *  pair availability is decided at quote time (some pairs fall back
   *  to providers with no inventory). `supports()` is just a coarse
   *  "is this asset on our map?" filter — call `quote()` for the
   *  real answer per pair. */
  supports(from: AssetId, to: AssetId): boolean {
    return from !== to && from in TROCADOR_COIN && to in TROCADOR_COIN;
  }

  async quote(req: QuoteRequest): Promise<SwapQuote> {
    if (!this.supports(req.fromAsset, req.toAsset)) {
      throw asSwapError('asset_pair_unsupported', `${req.fromAsset} -> ${req.toAsset}`);
    }
    const fromCoin = TROCADOR_COIN[req.fromAsset]!;
    const toCoin = TROCADOR_COIN[req.toAsset]!;
    const amountFromDecimal = atomicToDecimal(req.fromAmount, fromCoin.decimals);

    const params = new URLSearchParams({
      ticker_from: fromCoin.ticker,
      ticker_to: toCoin.ticker,
      network_from: fromCoin.network,
      network_to: toCoin.network,
      amount_from: amountFromDecimal,
      payment: 'False',
      min_kycrating: this.minKycRating,
    });
    if (this.markup) params.set('markup', this.markup);

    const res = await this.get<TrocadorRateResponse>('/new_rate', params);
    if (!res.trade_id) {
      throw asSwapError('network_error', 'Trocador returned no trade_id for /new_rate');
    }
    // Trocador returns providers sorted best-rate-first; take the top.
    const best = res.quotes.quotes[0];
    if (!best) {
      throw asSwapError('asset_pair_unsupported', 'No provider available for this pair/amount');
    }

    const amountToDecimal = best.amount_to;
    const toAmountEstimate = decimalToAtomic(amountToDecimal, toCoin.decimals);
    // Trocador surfaces fees only as the gap between amount_from_USD
    // and amount_to_USD. We materialize that as a from-asset atomic
    // amount the UI can render with the same formatter the rest of
    // the wallet uses.
    const feeEstimate = estimateFromAssetFee(
      best.amount_from_USD,
      best.amount_to_USD,
      amountFromDecimal,
      fromCoin.decimals,
    );

    return {
      fromAsset: req.fromAsset,
      toAsset: req.toAsset,
      fromAmount: req.fromAmount,
      toAmountEstimate,
      feeEstimate,
      // Trocador's `eta` is minutes; convert to seconds.
      etaSeconds: Math.round(best.eta * 60),
      // Floating-rate quotes are firm "for a few minutes" — Trocador
      // doesn't document an exact TTL, but Cake's heuristic of ~5 min
      // is the operational norm. UI should re-quote past this.
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      kind: this.kind,
      implementationData: {
        tradeId: res.trade_id,
        provider: best.provider,
        amountFromDecimal,
        amountToDecimal,
      } satisfies TrocadorImplementationData,
    };
  }

  async start(quote: SwapQuote): Promise<SwapStarted> {
    const impl = quote.implementationData as TrocadorImplementationData | null;
    if (!impl || !impl.tradeId || !impl.provider) {
      throw asSwapError('network_error', 'Quote is missing Trocador implementationData');
    }
    if (!('toAddress' in quote) && true) {
      // Intentional: SwapQuote doesn't carry the destination address
      // — caller has to supply it on start. Until QuoteRequest grows
      // a `toAddress` field, start() expects the caller to wrap the
      // quote with the address (see `startWithAddress` below).
      throw asSwapError(
        'network_error',
        'Use startWithAddress(quote, toAddress, refundAddress) — Trocador requires the destination on /new_trade',
      );
    }
    return this.startWithAddress(quote, '', '');
  }

  /**
   * Trocador's `/new_trade` finalizes the draft created by `/new_rate`
   * with a real destination + refund address. The Swap interface's
   * `start(quote)` doesn't carry an address (it predates Trocador-style
   * aggregators), so this is the address-aware companion. The wallet
   * UI calls this directly.
   *
   * `refundAddress` is required by every Trocador provider — if the
   * swap fails the deposited funds get returned here. Use the wallet's
   * own address for `fromAsset` if you don't have a separate refund
   * channel.
   */
  async startWithAddress(
    quote: SwapQuote,
    toAddress: string,
    refundAddress: string,
    extra?: { addressMemo?: string; refundMemo?: string },
  ): Promise<SwapStarted> {
    const impl = quote.implementationData as TrocadorImplementationData | null;
    if (!impl) {
      throw asSwapError('network_error', 'Quote is missing Trocador implementationData');
    }
    if (!toAddress) {
      throw asSwapError('network_error', 'Destination address required');
    }
    if (!refundAddress) {
      throw asSwapError('network_error', 'Refund address required by Trocador providers');
    }
    const fromCoin = TROCADOR_COIN[quote.fromAsset]!;
    const toCoin = TROCADOR_COIN[quote.toAsset]!;

    const params = new URLSearchParams({
      ticker_from: fromCoin.ticker,
      ticker_to: toCoin.ticker,
      network_from: fromCoin.network,
      network_to: toCoin.network,
      amount_from: impl.amountFromDecimal,
      payment: 'False',
      min_kycrating: this.minKycRating,
      address: toAddress,
      refund: refundAddress,
      refund_memo: extra?.refundMemo ?? '0',
      provider: impl.provider,
      id: impl.tradeId,
    });
    if (extra?.addressMemo) params.set('address_memo', extra.addressMemo);
    if (this.markup) params.set('markup', this.markup);
    if (this.opts.webhookUrl) params.set('webhook', this.opts.webhookUrl);
    if (this.opts.passthrough) params.set('passthrough', this.opts.passthrough);

    const res = await this.get<TrocadorTradeResponse>('/new_trade', params);
    if (!res.trade_id) {
      throw asSwapError('network_error', 'Trocador /new_trade returned no trade_id');
    }
    if (!res.address_provider) {
      throw asSwapError('network_error', 'Trocador /new_trade returned no deposit address');
    }
    return {
      id: res.trade_id,
      // For Trocador-style swaps "depositTxId" is the deposit
      // ADDRESS — the wallet hasn't broadcast anything yet. Caller
      // sends `quote.fromAmount` to this address via the normal Send
      // wizard; Trocador's webhook fires once the deposit is observed.
      depositTxId: res.address_provider,
    };
  }

  async status(id: SwapId): Promise<SwapStatus> {
    const params = new URLSearchParams({ id });
    const arr = await this.get<TrocadorTradeResponse[]>('/trade', params);
    const trade = Array.isArray(arr) ? arr[0] : null;
    if (!trade) {
      throw asSwapError('network_error', `Trocador /trade returned no body for ${id}`);
    }
    return mapStatus(trade);
  }

  // --- internals -----------------------------------------------------

  private async get<T>(path: string, params: URLSearchParams): Promise<T> {
    const url = `${this.baseUrl}${path}?${params.toString()}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { 'API-Key': this.opts.apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw asSwapError(
        'network_error',
        `Trocador ${path} HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    return (await res.json()) as T;
  }
}

function mapStatus(t: TrocadorTradeResponse): SwapStatus {
  switch (t.status as TrocadorStatus) {
    case 'new':
    case 'waiting':
      return { state: 'pending', reason: 'awaiting_deposit' };
    case 'confirming':
      return { state: 'pending', reason: 'awaiting_confirmations' };
    case 'exchanging':
    case 'sending':
      return { state: 'pending', reason: 'in_progress' };
    case 'finished':
      return {
        state: 'completed',
        // Trocador's response doesn't carry the outbound chain txid
        // in a stable field; `id_provider` is the closest analog
        // (the underlying CEX's order id). UI should treat it as
        // informational, not a chain explorer link.
        outboundTxId: t.id_provider || t.trade_id,
        toAmount: decimalToAtomicString(String(t.amount_to), TROCADOR_COIN[t.ticker_to]?.decimals ?? 8),
      };
    case 'refunded':
      return {
        state: 'refunded',
        refundTxId: t.refund_address || t.trade_id,
        reason: 'Trocador reported refunded',
      };
    case 'expired':
      return { state: 'failed', reason: 'Quote expired before deposit' };
    case 'error':
      return { state: 'failed', reason: 'Trocador reported error' };
    default:
      return { state: 'failed', reason: `Unknown Trocador status: ${t.status}` };
  }
}

// --- helpers (atomic <-> decimal string) -----------------------------

function atomicToDecimal(atomic: AtomicAmount, decimals: number): string {
  // AtomicAmount is a decimal string in atomic units. Insert the
  // decimal point at the right place; trim trailing zeros so Trocador
  // doesn't reject as malformed.
  const n = BigInt(atomic);
  if (decimals === 0) return n.toString();
  const padded = n.toString().padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

function decimalToAtomic(decimal: string, decimals: number): AtomicAmount {
  return decimalToAtomicString(decimal, decimals);
}

function decimalToAtomicString(decimal: string, decimals: number): string {
  const [whole, fracRaw = ''] = decimal.split('.');
  const frac = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  const combined = (whole ?? '0') + frac;
  // Strip leading zeros — but keep at least one digit.
  const trimmed = combined.replace(/^0+/, '') || '0';
  return trimmed;
}

/** Estimate the from-asset fee in atomic units by reading Trocador's
 *  USD pre/post values. Approximate; UI surfaces "≈ fee" not "fee = exact". */
function estimateFromAssetFee(
  fromUSD: string,
  toUSD: string,
  amountFromDecimal: string,
  fromDecimals: number,
): AtomicAmount {
  const f = parseFloat(fromUSD);
  const t = parseFloat(toUSD);
  if (!isFinite(f) || !isFinite(t) || f <= 0) return '0';
  const feeFraction = Math.max(0, (f - t) / f);
  const fromAtomic = BigInt(decimalToAtomicString(amountFromDecimal, fromDecimals));
  // Scale via integer math to avoid float precision drift on large
  // atomic amounts (BTC is fine, WOW at 11 decimals less so).
  const SCALE = 1_000_000n;
  const scaled = BigInt(Math.round(feeFraction * Number(SCALE)));
  return ((fromAtomic * scaled) / SCALE).toString();
}

function asSwapError(code: SwapError['code'], message: string): SwapError {
  const err = new Error(message) as SwapError;
  err.code = code;
  return err;
}
