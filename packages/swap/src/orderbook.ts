/**
 * Order-book math for swap venues that fill against a public book.
 *
 * Venue-agnostic: NonLogs today, any other order-book venue (CEXSwap) later.
 * Given the books for each leg of a route and an input amount, walk each book
 * level by level and report what the user would receive, the volume-weighted
 * price, the price impact against the mid price, and how much input the
 * visible books can absorb at all.
 *
 * WHY
 * ---
 * A venue's quote is an estimate that reserves nothing, and on a thin market
 * (WOW, GRIN) the difference between "the price" and "what this amount gets"
 * can be most of the trade. The book is the evidence: walking it shows the
 * user the real depth before they send anything.
 *
 * CONVENTIONS
 * -----------
 * A pair is `BASE-QUOTE` and every level is `[price, quantity]` with price in
 * QUOTE per BASE and quantity in BASE, both decimal strings (the NonLogs
 * shape). Holding BASE you SELL into the bids and receive QUOTE; holding
 * QUOTE you BUY from the asks and receive BASE.
 *
 * Arithmetic is exact fixed point (bigint, 18 decimal places), never JS
 * numbers: amounts come in as decimal strings and go out as decimal strings.
 * Percentages are reported as numbers because they are only displayed.
 */

/** Fixed-point scale: 18 decimal places. */
const SCALE = 10n ** 18n;

/** A fixed-point decimal: `value / SCALE`. */
export type Dec = bigint;

/** Parse a non-negative decimal string. Throws on anything else. */
export function dec(s: string): Dec {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`not a decimal: ${JSON.stringify(s)}`);
  const [int, frac = ''] = t.split('.');
  const f = (frac + '0'.repeat(18)).slice(0, 18);
  return BigInt(int!) * SCALE + BigInt(f);
}

/** Format a fixed-point decimal with at most `places` decimals, trimmed. */
export function fmt(d: Dec, places = 12): string {
  const neg = d < 0n;
  const v = neg ? -d : d;
  const int = v / SCALE;
  let frac = (v % SCALE).toString().padStart(18, '0').slice(0, places).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

export const mul = (a: Dec, b: Dec): Dec => (a * b) / SCALE;
export const div = (a: Dec, b: Dec): Dec => (b === 0n ? 0n : (a * SCALE) / b);
const min = (a: Dec, b: Dec): Dec => (a < b ? a : b);
/** A ratio as a display number, e.g. 0.0312 for 3.12 percent. */
const ratio = (num: Dec, den: Dec): number => (den === 0n ? 0 : Number((num * 1_000_000n) / den) / 1_000_000);

export type Level = readonly [price: string, quantity: string];

export interface OrderBook {
  /** `BASE-QUOTE`. */
  pair: string;
  bids: ReadonlyArray<Level>;
  asks: ReadonlyArray<Level>;
}

export type Side = 'sell' | 'buy';

export interface Leg {
  pair: string;
  base: string;
  quote: string;
  /** `sell`: input is BASE, output QUOTE. `buy`: input QUOTE, output BASE. */
  side: Side;
  /** Asset the leg consumes. */
  from: string;
  /** Asset the leg produces. */
  to: string;
}

export interface LegResult {
  leg: Leg;
  /** Input consumed, in the leg's input asset. */
  filledIn: Dec;
  /** Output before fees, in the leg's output asset. */
  grossOut: Dec;
  /** Output after this leg's trading fee. */
  netOut: Dec;
  /** Volume-weighted price, QUOTE per BASE; 0 when nothing filled. */
  vwap: Dec;
  /** Mid of best bid and best ask; null when either side is empty. */
  mid: Dec | null;
  /** Worse-than-mid fraction (0.03 = 3 percent); null without a mid. */
  impact: number | null;
  /** True when the visible book ran out before the input did. */
  exhausted: boolean;
  /** The most input this side of the book can absorb. */
  depthIn: Dec;
}

/** Levels as fixed point, best first, dropping malformed or empty ones. */
function levels(raw: ReadonlyArray<Level>, best: 'high' | 'low'): Array<[Dec, Dec]> {
  const out: Array<[Dec, Dec]> = [];
  for (const l of raw) {
    try {
      const p = dec(l[0]);
      const q = dec(l[1]);
      if (p > 0n && q > 0n) out.push([p, q]);
    } catch {
      // A malformed level is skipped, never guessed at.
    }
  }
  out.sort((a, b) => (best === 'high' ? (b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : 0) : a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0));
  return out;
}

function midOf(book: OrderBook): Dec | null {
  const bid = levels(book.bids, 'high')[0]?.[0];
  const ask = levels(book.asks, 'low')[0]?.[0];
  return bid !== undefined && ask !== undefined ? (bid + ask) / 2n : null;
}

/**
 * Walk one book. `takerFee` is a fraction (0.0015 for 0.15 percent) taken
 * from the leg's output, as a venue charges a taker on each filled order.
 */
export function walkLeg(book: OrderBook, leg: Leg, amountIn: Dec, takerFee: Dec = 0n): LegResult {
  const mid = midOf(book);
  let remaining = amountIn;
  let out = 0n;
  let depthIn = 0n;
  if (leg.side === 'sell') {
    // Holding BASE: hit the bids, best (highest) first.
    for (const [price, qty] of levels(book.bids, 'high')) {
      depthIn += qty;
      if (remaining === 0n) continue;
      const take = min(remaining, qty);
      out += mul(take, price);
      remaining -= take;
    }
  } else {
    // Holding QUOTE: lift the asks, best (lowest) first.
    for (const [price, qty] of levels(book.asks, 'low')) {
      const cost = mul(qty, price);
      depthIn += cost;
      if (remaining === 0n) continue;
      if (remaining >= cost) {
        out += qty;
        remaining -= cost;
      } else {
        out += div(remaining, price);
        remaining = 0n;
      }
    }
  }
  const filledIn = amountIn - remaining;
  const vwap = filledIn === 0n || out === 0n ? 0n : leg.side === 'sell' ? div(out, filledIn) : div(filledIn, out);
  let impact: number | null = null;
  if (mid !== null && vwap > 0n) {
    impact = leg.side === 'sell' ? ratio(mid - vwap, mid) : ratio(vwap - mid, mid);
  }
  const netOut = out - mul(out, takerFee);
  return { leg, filledIn, grossOut: out, netOut, vwap, mid, impact, exhausted: remaining > 0n, depthIn };
}

/**
 * Route `from` to `to` over the markets that exist. Direct pair first, then
 * one bridge asset, in the order given. Returns null when no route exists.
 */
export function planRoute(
  from: string,
  to: string,
  markets: ReadonlySet<string>,
  bridges: ReadonlyArray<string> = ['BTC', 'XMR', 'USDT'],
): Leg[] | null {
  const F = from.toUpperCase();
  const T = to.toUpperCase();
  const direct = legBetween(F, T, markets);
  if (direct) return [direct];
  for (const b of bridges) {
    if (b === F || b === T) continue;
    const first = legBetween(F, b, markets);
    const second = legBetween(b, T, markets);
    if (first && second) return [first, second];
  }
  return null;
}

/** The leg that turns `from` into `to`, if a market for the pair exists. */
export function legBetween(from: string, to: string, markets: ReadonlySet<string>): Leg | null {
  if (markets.has(`${to}-${from}`)) return { pair: `${to}-${from}`, base: to, quote: from, side: 'buy', from, to };
  if (markets.has(`${from}-${to}`)) return { pair: `${from}-${to}`, base: from, quote: to, side: 'sell', from, to };
  return null;
}

/** Turn a list of pair symbols (a venue's reported route) into legs. */
export function legsFromPairs(from: string, pairs: ReadonlyArray<string>): Leg[] | null {
  let holding = from.toUpperCase();
  const legs: Leg[] = [];
  for (const p of pairs) {
    const [base, quote] = p.toUpperCase().split('-');
    if (!base || !quote) return null;
    if (holding === base) legs.push({ pair: `${base}-${quote}`, base, quote, side: 'sell', from: base, to: quote });
    else if (holding === quote) legs.push({ pair: `${base}-${quote}`, base, quote, side: 'buy', from: quote, to: base });
    else return null;
    holding = legs[legs.length - 1]!.to;
  }
  return legs.length > 0 ? legs : null;
}

export interface Fees {
  /** Taker fee per filled leg, as a fraction (0.0015 = 0.15 percent). */
  takerFee: Dec;
  /** Venue fee on the whole swap, as a fraction of the output (0.008). */
  convenienceFee: Dec;
  /** Absolute outgoing network fee, in the output asset; 0 when unknown. */
  networkFeeOut: Dec;
}

export const NO_FEES: Fees = { takerFee: 0n, convenienceFee: 0n, networkFeeOut: 0n };

export interface RouteResult {
  legs: LegResult[];
  /** What the user receives after every fee, in the output asset. */
  expectedOut: Dec;
  /** Output before fees: the books alone. */
  grossOut: Dec;
  /** Effective price, output per unit of input, after fees. */
  effectiveRate: Dec;
  /** Combined price impact across legs; null when a leg has no mid. */
  impact: number | null;
  /** True when any leg's visible book ran out. */
  exceedsDepth: boolean;
  /** Largest input the visible books fill completely. */
  maxInput: Dec;
}

/** Walk a whole route, feeding each leg's net output into the next. */
export function walkRoute(
  legs: ReadonlyArray<Leg>,
  books: ReadonlyMap<string, OrderBook>,
  amountIn: Dec,
  fees: Fees = NO_FEES,
): RouteResult {
  const results: LegResult[] = [];
  let carry = amountIn;
  let grossCarry = amountIn;
  for (const leg of legs) {
    const book = books.get(leg.pair);
    if (!book) throw new Error(`missing order book for ${leg.pair}`);
    const r = walkLeg(book, leg, carry, fees.takerFee);
    results.push(r);
    carry = r.netOut;
    grossCarry = walkLeg(book, leg, grossCarry).grossOut;
  }
  const afterConvenience = carry - mul(carry, fees.convenienceFee);
  const expectedOut = afterConvenience > fees.networkFeeOut ? afterConvenience - fees.networkFeeOut : 0n;
  let impact: number | null = 0;
  for (const r of results) {
    if (r.impact === null) {
      impact = null;
      break;
    }
    impact = 1 - (1 - impact) * (1 - r.impact);
  }
  return {
    legs: results,
    expectedOut,
    grossOut: grossCarry,
    effectiveRate: div(expectedOut, amountIn),
    impact,
    exceedsDepth: results.some((r) => r.exhausted),
    maxInput: maxFillableInput(legs, books),
  };
}

/** The largest input every leg fills completely, by bisection. */
export function maxFillableInput(legs: ReadonlyArray<Leg>, books: ReadonlyMap<string, OrderBook>): Dec {
  const first = legs[0];
  if (!first) return 0n;
  const firstBook = books.get(first.pair);
  if (!firstBook) return 0n;
  let hi = walkLeg(firstBook, first, 0n).depthIn;
  const fills = (x: Dec): boolean => {
    let carry = x;
    for (const leg of legs) {
      const r = walkLeg(books.get(leg.pair)!, leg, carry);
      if (r.exhausted) return false;
      carry = r.grossOut;
    }
    return true;
  };
  if (hi === 0n || fills(hi)) return hi;
  let lo = 0n;
  for (let i = 0; i < 64 && hi - lo > 1n; i++) {
    const m = (lo + hi) / 2n;
    if (fills(m)) lo = m;
    else hi = m;
  }
  return lo;
}

export type DepthWarning = 'none' | 'notice' | 'strong' | 'exceeds_depth' | 'no_market';

/** Thresholds for warning about price impact (fractions). */
export const IMPACT_NOTICE = 0.03;
export const IMPACT_STRONG = 0.1;

/** How loudly to warn about this fill. */
export function depthWarning(r: RouteResult | null): DepthWarning {
  if (!r) return 'no_market';
  if (r.exceedsDepth) return 'exceeds_depth';
  if (r.impact === null) return 'notice';
  if (r.impact >= IMPACT_STRONG) return 'strong';
  if (r.impact >= IMPACT_NOTICE) return 'notice';
  return 'none';
}

/**
 * Whether two estimates differ enough to show both: more than `tolerance`
 * of the larger one (default 2 percent).
 */
export function materiallyDifferent(a: Dec, b: Dec, tolerance = 0.02): boolean {
  const hi = a > b ? a : b;
  const lo = a > b ? b : a;
  if (hi === 0n) return false;
  return ratio(hi - lo, hi) > tolerance;
}
