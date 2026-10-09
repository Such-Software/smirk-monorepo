/**
 * WhereToTrade: venues for WOW and GRIN outside the wallet. WOW swaps run
 * in-app through NonLogs when the wallet server offers it (the provider list
 * above); GRIN has no route a wallet can complete on its own, since a Grin
 * deposit to an exchange is an interactive slatepack exchange. So the panel
 * links out and labels each venue's trust model, with live DEX prices from
 * our own Neroswap aggregator when they load.
 *
 * Strictly presentational: the consumer supplies prices (best-effort; the
 * panel renders without them) and nothing here moves funds.
 *
 * Prices load only when the user taps for them. They come from neroswap.com,
 * a third party as far as the network can tell, and opening the Swap tab is
 * not consent to contact one: a mount-time fetch told Neroswap's CDN the
 * user's IP every time the tab (or a popup reopened onto it) rendered.
 */

import { useState } from 'preact/hooks';

export interface TradeVenue {
  name: string;
  kind: 'DEX' | 'CEX';
  /** One line on how it works and what it costs in trust. */
  note: string;
  href: string;
  assets: ReadonlyArray<'wow' | 'grin'>;
}

/** Vetted 2026-10-07 (journal: ops/direction, Swap Providers Research). */
export const TRADE_VENUES: ReadonlyArray<TradeVenue> = [
  {
    name: 'BasicSwap',
    kind: 'DEX',
    note: 'Atomic swaps from your own node. Non-custodial; you run the software.',
    href: 'https://basicswapdex.com',
    assets: ['wow'],
  },
  {
    name: 'NonLogs',
    kind: 'CEX',
    note: 'Order-book exchange. On its site you deposit to an account; WOW swaps also run in this wallet when offered.',
    href: 'https://nonlogs.io',
    assets: ['wow', 'grin'],
  },
  {
    name: 'CEXSwap',
    kind: 'CEX',
    note: 'Exchange with small AMM pools. Custodial: you deposit to an account.',
    href: 'https://cexswap.cc',
    assets: ['wow', 'grin'],
  },
];

/** Best DEX prices for one pair, as Neroswap's `/api/v1/best` reports them. */
export interface TradePairPrice {
  /** e.g. `WOW-BTC`. */
  pair: string;
  bestBid: number | null;
  bestAsk: number | null;
}

export interface WhereToTradeProps {
  /** Best-effort live prices, fetched only on the user's tap. Omit, or
   *  reject, and the panel still renders. */
  loadPrices?: () => Promise<TradePairPrice[]>;
  /** Where "compare prices" links to. */
  compareHref?: string;
}

type PriceState = 'idle' | 'loading' | 'loaded' | 'failed';

export function WhereToTrade({ loadPrices, compareHref = 'https://neroswap.com' }: WhereToTradeProps) {
  const [prices, setPrices] = useState<TradePairPrice[] | null>(null);
  const [state, setState] = useState<PriceState>('idle');
  const showPrices = () => {
    if (!loadPrices || state === 'loading') return;
    setState('loading');
    loadPrices()
      .then((p) => {
        setPrices(p);
        setState('loaded');
      })
      .catch(() => {
        setPrices(null);
        setState('failed');
      });
  };

  const quoted = (prices ?? []).filter((p) => p.bestBid !== null || p.bestAsk !== null);
  return (
    <section
      data-testid="swap-where-to-trade"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}
    >
      <h3 style={{ margin: 0, fontSize: 13 }}>Where to trade WOW and GRIN</h3>
      <p style={{ margin: 0, fontSize: 11, color: 'var(--smirk-fg-muted)', lineHeight: 1.45 }}>
        No swap service routes these coins without holding your funds, so Smirk
        links out instead of swapping for you.
      </p>
      {TRADE_VENUES.map((v) => (
        <a
          key={v.name}
          href={v.href}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            padding: '8px 10px',
            border: '1px solid var(--smirk-border)',
            borderRadius: 'var(--smirk-radius, 8px)',
            color: 'inherit',
            textDecoration: 'none',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.05em',
                padding: '1px 5px',
                borderRadius: 4,
                background: 'rgba(255,255,255,0.06)',
                color: 'var(--smirk-fg-muted)',
              }}
            >
              {v.kind}
            </span>
            {v.name}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--smirk-fg-muted)' }}>
              {v.assets.map((a) => a.toUpperCase()).join(' · ')}
            </span>
          </span>
          <span style={{ fontSize: 11, color: 'var(--smirk-fg-muted)' }}>{v.note}</span>
        </a>
      ))}
      {loadPrices && state !== 'loaded' && (
        <button
          type="button"
          onClick={showPrices}
          disabled={state === 'loading'}
          data-testid="swap-where-to-trade-show-prices"
          style={{
            alignSelf: 'flex-start',
            padding: '4px 8px',
            fontSize: 11,
            background: 'transparent',
            color: 'inherit',
            border: '1px solid var(--smirk-border)',
            borderRadius: 'var(--smirk-radius, 8px)',
            cursor: state === 'loading' ? 'default' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {state === 'loading'
            ? 'Loading prices…'
            : state === 'failed'
              ? 'Prices unavailable. Try again'
              : 'Show live DEX prices (asks neroswap.com, which sees your IP address)'}
        </button>
      )}
      {quoted.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span>Best DEX prices right now:</span>
          {quoted.map((p) => (
            <span key={p.pair} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {p.pair}: {p.bestBid !== null ? `bid ${p.bestBid}` : 'no bid'}, {p.bestAsk !== null ? `ask ${p.bestAsk}` : 'no ask'}
            </span>
          ))}
        </div>
      )}
      <a href={compareHref} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>
        Compare live prices on Neroswap
      </a>
    </section>
  );
}
