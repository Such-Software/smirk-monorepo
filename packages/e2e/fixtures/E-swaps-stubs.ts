/**
 * Provider stubs for the deterministic swap scenarios in tests/swap.spec.ts.
 *
 * The wallet code under test is the real extension; only the providers'
 * HTTP answers are recorded fixtures (packages/swap/src/__tests__/fixtures),
 * and the wallet server's capabilities are the real ones with the `swaps`
 * section set by the test. Every request is recorded by host and path so a
 * scenario can assert who was contacted, and when.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { BACKEND_URL } from './extension.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'swap', 'src', '__tests__', 'fixtures');
const load = (path: string): Record<string, unknown> => JSON.parse(readFileSync(join(fixtures, path), 'utf8'));

export const THOR = load('thorchain/mainnet-btc-ltc.json') as Record<string, any>;
const XMR = load('thorchain/xmr-synthesized.json') as Record<string, any>;
const BOOK_WOW_XMR = load('nonlogs/ob-WOW-XMR.json');

export const THOR_GATEWAY_HOST = 'gateway.liquify.com';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });

export interface Seen {
  at: number;
  method: string;
  host: string;
  path: string;
}

/** Record every http(s) request a page or context makes. */
export function recordRequests(target: Page | BrowserContext): Seen[] {
  const seen: Seen[] = [];
  target.on('request', (request) => {
    try {
      const url = new URL(request.url());
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        seen.push({ at: Date.now(), method: request.method(), host: url.host, path: url.pathname });
      }
    } catch {
      // Not a URL we track.
    }
  });
  return seen;
}

/** The wallet server's real capabilities, with `swaps` replaced. */
export async function stubSwapCapabilities(target: Page | BrowserContext, swaps: Record<string, unknown>): Promise<void> {
  const base = BACKEND_URL.replace(/\/$/, '');
  await target.route(
    (url) => url.href.startsWith(base) && url.pathname.endsWith('/capabilities'),
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, swaps } });
    },
  );
}

/**
 * THORChain from the recorded mainnet fixture. Quotes accept any amount (the
 * recorded minimum is lowered), carry a memo naming the requested
 * destination, and expire ten minutes from now. `xmrPool` adds an available
 * XMR pool and vault, so XMR's absence proves the wallet's own policy.
 */
export async function stubThorchain(target: Page | BrowserContext, opts: { xmrPool?: boolean } = {}): Promise<{ quotes: URLSearchParams[] }> {
  const quotes: URLSearchParams[] = [];
  await target.route(/^https:\/\/gateway\.liquify\.com\//, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/chain\/thorchain_api/, '');
    if (path === '/thorchain/pools') return json(route, [...THOR.pools, ...(opts.xmrPool ? [XMR.pool_xmr] : [])]);
    if (path === '/thorchain/inbound_addresses') {
      return json(route, [...THOR.inbound_addresses, ...(opts.xmrPool ? [XMR.inbound_xmr] : [])]);
    }
    if (path === '/thorchain/lastblock') return json(route, [{ chain: 'BTC', thorchain: 1_000 }]);
    if (path.startsWith('/thorchain/thorname/')) {
      return json(route, { name: decodeURIComponent(path.split('/').pop() ?? ''), expire_block_height: 99_999_999 });
    }
    if (path.startsWith('/thorchain/tx/status/')) return json(route, THOR.tx_status_unknown);
    if (path === '/thorchain/quote/swap') {
      const q = url.searchParams;
      quotes.push(q);
      const pair = `${q.get('from_asset')}>${q.get('to_asset')}`;
      const affiliate = q.get('affiliate');
      const recorded =
        pair === 'BTC.BTC>LTC.LTC'
          ? affiliate
            ? THOR.quote_btc_to_ltc_affiliate
            : THOR.quote_btc_to_ltc
          : pair === 'LTC.LTC>BTC.BTC'
            ? THOR.quote_ltc_to_btc
            : null;
      if (!recorded) return json(route, { code: 3, message: 'pool not available in this stub' }, 400);
      const destination = q.get('destination');
      const short = q.get('to_asset') === 'LTC.LTC' ? 'l' : 'b';
      return json(route, {
        ...recorded,
        recommended_min_amount_in: '1',
        expiry: Math.floor(Date.now() / 1000) + 600,
        memo: destination
          ? `=:${short}:${destination}:1${affiliate ? `:${affiliate}:${q.get('affiliate_bps')}` : ''}`
          : recorded.memo,
      });
    }
    return json(route, { message: 'not in this stub' }, 404);
  });
  return { quotes };
}

/** A thin book: one 1 WOW ask (0.000017 XMR deep), so 0.0001 XMR exceeds it. */
const THIN_WOW_XMR = { pair: 'WOW-XMR', timestamp: '2026-10-07T16:07:04Z', bids: [], asks: [['0.00001700', '1.00000000000']] };

/**
 * NonLogs through the wallet server's `/swaps/nonlogs/*` routes. GRIN is
 * listed too, so its absence proves the wallet's own exclusion. `book` picks
 * the recorded WOW-XMR book or a thin one; creating a swap answers 500 and is
 * recorded, since no scenario here may create one.
 */
export async function stubNonlogs(target: Page | BrowserContext): Promise<{ setBook(kind: 'recorded' | 'thin'): void; created: number[] }> {
  const base = BACKEND_URL.replace(/\/$/, '');
  let book: 'recorded' | 'thin' = 'recorded';
  const created: number[] = [];
  await target.route(
    (url) => url.href.startsWith(`${base}/swaps/nonlogs`),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/swaps/nonlogs/assets')) {
        return json(route, {
          creation_enabled: true,
          assets: ['BTC', 'LTC', 'XMR', 'WOW', 'GRIN'].map((symbol) => ({ symbol, available: true })),
        });
      }
      if (path.endsWith('/swaps/nonlogs/quote')) {
        return json(route, { estimated_receive: '5.25', minimum: '0.01', route: ['WOW-XMR'] });
      }
      if (path.includes('/swaps/nonlogs/orderbook/')) {
        return json(route, book === 'thin' ? THIN_WOW_XMR : BOOK_WOW_XMR);
      }
      if (/\/swaps\/nonlogs\/?$/.test(path) && route.request().method() === 'POST') {
        created.push(Date.now());
        return json(route, { error: 'no swap may be created in this scenario' }, 500);
      }
      return json(route, { error: 'not in this stub' }, 404);
    },
  );
  return {
    setBook(kind) {
      book = kind;
    },
    created,
  };
}

/** Neroswap's best-price answer for the Where to trade panel. */
export async function stubNeroswap(target: Page | BrowserContext): Promise<void> {
  await target.route(/^https:\/\/neroswap\.com\//, (route) => json(route, { consolidated: { bestBid: 0.0000012, bestAsk: 0.0000013 } }));
}
