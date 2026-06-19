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
  SwapStartParams,
  SwapStarted,
  SwapStatus,
} from './types';

/**
 * Smirk asset id → Trocador (ticker, network, decimals) mapping.
 *
 * **Why only BTC/LTC/XMR.** Probed 2026-06-02 against
 * api.trocador.app with the live affiliate key:
 *   - WOW: `{"error": "coin not found"}` — not in Trocador's coin
 *     list at all (the docs called it "best-effort" but the
 *     reality is zero coverage).
 *   - GRIN: in the coin list but every quote at every reasonable
 *     amount returns `{"error": "amount higher than max or lower
 *     than min"}` — no provider has GRIN inventory.
 *
 * Surfacing either in the picker just funnels users into "no
 * provider available" errors and erodes trust in the swap surface.
 * Re-enable when Trocador's coverage actually catches up; until
 * then native atomic swaps (Grin↔BTC v0.4, WOW↔XMR v0.6) are the
 * real path for these assets.
 */
const TROCADOR_COIN: Record<string, { ticker: string; network: string; decimals: number }> = {
  btc: { ticker: 'btc', network: 'Mainnet', decimals: 8 },
  ltc: { ticker: 'ltc', network: 'Mainnet', decimals: 8 },
  xmr: { ticker: 'xmr', network: 'Mainnet', decimals: 12 },
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
  /** Trocador's JSON often serializes amounts as numbers, sometimes
   *  as strings. Accept both — `normalizeAmountString()` narrows to
   *  a string for precision-safe BigInt math (avoids float drift on
   *  WOW=11 dec,
   *  XMR=12 dec). */
  amount_from: number | string;
  amount_to: number | string;
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

/** Trocador can serialize amounts as either number or string. Always
 *  read through this helper so the precision-loss vector for high-
 *  decimal assets (WOW=11, XMR=12) is one well-marked spot. */
function normalizeAmountString(v: number | string | undefined | null): string {
  if (v === undefined || v === null) return '0';
  if (typeof v === 'string') return v;
  // Stringify with enough digits to round-trip. Number→string is
  // lossy past 2^53; we accept that as a Trocador-server-side issue
  // (their response will have already lost precision before it
  // reached us). The fallback to '0' on NaN/Infinity prevents
  // downstream BigInt() throws.
  if (!Number.isFinite(v)) return '0';
  return v.toString();
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

  /** UI filter helper: does Trocador handle this asset at all,
   *  regardless of pair? Use when building from/to chooser lists
   *  (`supports()` requires from !== to so it would wrongly exclude
   *  an asset from "asset is selectable"). */
  isKnownAsset(assetId: AssetId): boolean {
    return assetId in TROCADOR_COIN;
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

  /**
   * Finalize a quote into a real trade by calling `/new_trade`.
   *
   * Aggregator-shape contract: requires `toAddress` (where to-asset
   * lands) and `refundAddress` (where from-asset returns on failure).
   * Throws `SwapError` with code `not_implemented` if either is
   * missing — better than silently sending to an empty address or
   * forgetting the refund destination.
   *
   * Optional address memos can ride through `params.counterpartyData`
   * shaped as `{ addressMemo?, refundMemo? }`. The protocol is
   * single-shot for aggregators, so `counterpartyData` is a thin
   * extension point rather than a multi-round channel.
   */
  async start(params: SwapStartParams): Promise<SwapStarted> {
    const { quote, toAddress, refundAddress } = params;
    const impl = quote.implementationData as TrocadorImplementationData | null;
    if (!impl || !impl.tradeId || !impl.provider) {
      throw asSwapError(
        'network_error',
        'Quote is missing Trocador implementationData — was it produced by TrocadorSwap.quote()?',
      );
    }
    if (!toAddress) {
      throw asSwapError(
        'not_implemented',
        'Trocador.start requires `toAddress` — where the swap output lands.',
      );
    }
    if (!refundAddress) {
      throw asSwapError(
        'not_implemented',
        'Trocador.start requires `refundAddress` — provider returns funds here on failure.',
      );
    }
    const extra = (params.counterpartyData ?? {}) as {
      addressMemo?: string;
      refundMemo?: string;
    };
    const fromCoin = TROCADOR_COIN[quote.fromAsset]!;
    const toCoin = TROCADOR_COIN[quote.toAsset]!;

    const tradeParams = new URLSearchParams({
      ticker_from: fromCoin.ticker,
      ticker_to: toCoin.ticker,
      network_from: fromCoin.network,
      network_to: toCoin.network,
      amount_from: impl.amountFromDecimal,
      payment: 'False',
      min_kycrating: this.minKycRating,
      address: toAddress,
      refund: refundAddress,
      refund_memo: extra.refundMemo ?? '0',
      provider: impl.provider,
      id: impl.tradeId,
    });
    if (extra.addressMemo) tradeParams.set('address_memo', extra.addressMemo);
    if (this.markup) tradeParams.set('markup', this.markup);
    if (this.opts.webhookUrl) tradeParams.set('webhook', this.opts.webhookUrl);
    // Per-trade passthrough takes precedence over the constructor
    // default. The wallet generates a fresh random token per swap so
    // each trade has its own webhook secret — pre-2026-06-13 this was
    // generated and persisted to the backend but never threaded into
    // /new_trade, so every webhook delivery arrived with passthrough
    // empty and was rejected by the backend's constant-time check.
    // The 60s backup poller silently masked it; the primary push
    // path was dead end-to-end. See SwapStartParams.passthrough.
    const passthrough = params.passthrough ?? this.opts.passthrough;
    if (passthrough) tradeParams.set('passthrough', passthrough);

    const res = await this.get<TrocadorTradeResponse>('/new_trade', tradeParams);
    if (!res.trade_id) {
      throw asSwapError('network_error', 'Trocador /new_trade returned no trade_id');
    }
    // Trocador returns the literal string "0" for `address_provider`
    // when the trade draft hasn't been fully finalized server-side
    // (e.g. provider out of inventory at finalize time). Falling
    // through here sends user funds to literal "0".
    if (!res.address_provider || res.address_provider === '0') {
      throw asSwapError(
        'network_error',
        'Trocador /new_trade returned no deposit address. The chosen provider may be out of inventory — re-quote.',
      );
    }
    return {
      id: res.trade_id,
      depositAddress: res.address_provider,
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
  // Don't cast to TrocadorStatus — that hides unknown future states
  // from the type system. The default branch handles them at runtime.
  switch (t.status) {
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
        // Trocador's `id_provider` is the underlying CEX's order id —
        // NOT a chain txid. We pass it through unchanged so the UI
        // can render it informationally; leaving empty when absent
        // (was previously falling back to trade_id, which would
        // render as a broken explorer link).
        outboundTxId: t.id_provider || '',
        toAmount: decimalToAtomicString(
          normalizeAmountString(t.amount_to),
          TROCADOR_COIN[t.ticker_to]?.decimals ?? 8,
        ),
      };
    case 'refunded':
      return {
        state: 'refunded',
        // Similarly: refund_address is a wallet address, NOT a refund
        // txid. Leave empty; UI displays "refunded to your refund
        // address" instead of pretending to link a tx.
        refundTxId: '',
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
