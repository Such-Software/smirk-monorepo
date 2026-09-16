/**
 * AltQuick provider tests.
 *
 * The fixtures are one coherent snapshot: three exchange books and the swap
 * API's market entries, captured back to back. That lets the central property
 * be checked against the venue itself: walking the books for the venue's own
 * maximum lands within half a percent of what AltQuick says it would pay, and
 * never above it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AltQuickSwap } from '../index';
import type { SwapError, SwapQuote } from '../index';
import * as fx from './fixtures/altquick';

const DECIMALS: Record<string, number> = { btc: 8, ltc: 8, xmr: 12, wow: 11 };

function atomic(decimal: string, asset: string): string {
  const d = DECIMALS[asset]!;
  const [w, f = ''] = decimal.split('.');
  return (w + (f + '0'.repeat(d)).slice(0, d)).replace(/^0+/, '') || '0';
}

function toNumber(atomicAmount: string, asset: string): number {
  return Number(atomicAmount) / 10 ** DECIMALS[asset]!;
}

const MARKETS: Record<string, unknown> = {
  'BTC-WOW': fx.market_BTC_WOW,
  'XMR-WOW': fx.market_XMR_WOW,
  'LTC-WOW': fx.market_LTC_WOW,
  'WOW-BTC': fx.market_WOW_BTC,
  'WOW-XMR': fx.market_WOW_XMR,
  'WOW-LTC': fx.market_WOW_LTC,
};
const BOOKS: Record<string, unknown> = {
  BTC_WOW: fx.book_BTC_WOW,
  BTC_XMR: fx.book_BTC_XMR,
  BTC_LTC: fx.book_BTC_LTC,
};

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function venue(overrides: Record<string, Handler> = {}): { swap: AltQuickSwap; calls: { url: URL; init?: RequestInit }[] } {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetchStub = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const [prefix, handler] of Object.entries(overrides)) {
      if (url.pathname.startsWith(prefix)) return handler(url, init);
    }
    const m = url.pathname.match(/\/swap\/api\/v1\/market\/(.+)$/);
    if (m) return new Response(MARKETS[m[1]!] ? JSON.stringify(MARKETS[m[1]!]) : '', { status: 200 });
    const b = url.pathname.match(/\/api\/v2\/orderbook\/(.+)$/);
    if (b && BOOKS[b[1]!]) return new Response(JSON.stringify(BOOKS[b[1]!]), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { swap: new AltQuickSwap({ fetch: fetchStub, timeoutMs: 200 }), calls };
}

async function rejectsWith(p: Promise<unknown>, code: SwapError['code']) {
  await assert.rejects(p, (e: unknown) => (e as SwapError).code === code);
}

describe('AltQuickSwap pairs', () => {
  it('handles WOW against BTC, LTC and XMR, in both directions', () => {
    const { swap } = venue();
    for (const c of ['btc', 'ltc', 'xmr']) {
      assert.ok(swap.supports(c, 'wow'));
      assert.ok(swap.supports('wow', c));
    }
  });

  it('leaves pairs without WOW to the other providers', () => {
    const { swap } = venue();
    assert.equal(swap.supports('btc', 'xmr'), false);
    assert.equal(swap.supports('wow', 'wow'), false);
    assert.equal(swap.supports('grin', 'wow'), false);
  });
});

describe('AltQuickSwap quote', () => {
  for (const pair of ['BTC-WOW', 'XMR-WOW', 'LTC-WOW', 'WOW-BTC', 'WOW-XMR', 'WOW-LTC'] as const) {
    it(`${pair}: at the venue's own maximum, the walk matches AltQuick within 0.5% and never overstates`, async () => {
      const { swap } = venue();
      const [f, t] = pair.toLowerCase().split('-') as [string, string];
      const market = MARKETS[pair] as { max: string; ratesWithFees: { to: { amount: string } } };
      const q = await swap.quote({ fromAsset: f, toAsset: t, fromAmount: atomic(market.max, f) });
      const ours = toNumber(q.toAmountEstimate, t);
      const theirs = Number(market.ratesWithFees.to.amount);
      assert.ok(ours <= theirs * 1.0001, `estimate ${ours} overstates AltQuick's ${theirs}`);
      assert.ok(ours >= theirs * 0.995, `estimate ${ours} is more than 0.5% under AltQuick's ${theirs}`);
    });
  }

  it('prices a small swap better than the max-size average would', async () => {
    const { swap } = venue();
    const market = fx.market_BTC_WOW;
    const small = await swap.quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: atomic('0.0006', 'btc') });
    const smallRate = 0.0006 / toNumber(small.toAmountEstimate, 'wow');
    const maxAverage = Number(market.ratesWithFees.to.btctotal) / Number(market.ratesWithFees.to.amount);
    assert.ok(smallRate < maxAverage, `small-swap rate ${smallRate} is not better than the max average ${maxAverage}`);
  });

  it('refuses an amount under the minimum as insufficient', async () => {
    const { swap } = venue();
    await rejectsWith(swap.quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: atomic('0.0001', 'btc') }), 'insufficient_amount');
  });

  it('refuses an amount over the maximum with its own code', async () => {
    const { swap } = venue();
    await rejectsWith(swap.quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: atomic('0.01', 'btc') }), 'amount_above_max');
  });

  it('refuses a closed pair', async () => {
    const { swap } = venue({
      '/swap/api/v1/market/': () => new Response(JSON.stringify({ ...fx.market_BTC_WOW, closed: true, min: '0', max: '0' })),
    });
    await rejectsWith(swap.quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: atomic('0.001', 'btc') }), 'asset_pair_unsupported');
  });

  it('treats the empty body AltQuick sends for an unknown pair as unsupported', async () => {
    const { swap } = venue({ '/swap/api/v1/market/': () => new Response('', { status: 200 }) });
    await rejectsWith(swap.quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: atomic('0.001', 'btc') }), 'asset_pair_unsupported');
  });

  it('marks the quote as unlocked with a short expiry', async () => {
    const { swap } = venue();
    const q = await swap.quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: atomic('0.001', 'btc') });
    assert.ok(q.expiresAt.getTime() - Date.now() <= 60_000);
    assert.equal(q.kind, 'aggregator');
  });
});

function quoteFor(swap: AltQuickSwap): Promise<SwapQuote> {
  return swap.quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: atomic('0.001', 'btc') });
}

const WOW_ADDRESS = 'W'.repeat(97);
const BTC_REFUND = 'bc1q' + 'x'.repeat(38);

describe('AltQuickSwap start', () => {
  it('sends toAddress and the refund as emergencyAddress, and returns the deposit address', async () => {
    const { swap, calls } = venue({
      '/swap/api/v1/trade': () =>
        new Response(JSON.stringify({ uuid: 'u-1', fromAddress: 'bc1qdeposit' + 'y'.repeat(30), state: 'awaitingDeposit' })),
    });
    const started = await swap.start({ quote: await quoteFor(swap), toAddress: WOW_ADDRESS, refundAddress: BTC_REFUND });
    assert.equal(started.id, 'u-1');
    assert.ok(started.depositAddress.startsWith('bc1qdeposit'));
    const post = calls.find((c) => c.init?.method === 'POST')!;
    const body = JSON.parse(String(post.init!.body));
    assert.equal(body.toAddress, WOW_ADDRESS);
    assert.equal(body.emergencyAddress, BTC_REFUND);
    assert.equal('affiliateId' in body, false);
  });

  it('includes affiliateId only when configured', async () => {
    let seen: Record<string, string> = {};
    const fetchStub = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        seen = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ uuid: 'u-2', fromAddress: 'bc1q' + 'z'.repeat(38) }));
      }
      const m = url.pathname.match(/market\/(.+)$/);
      if (m) return new Response(JSON.stringify(MARKETS[m[1]!]));
      const b = url.pathname.match(/orderbook\/(.+)$/)!;
      return new Response(JSON.stringify(BOOKS[b[1]!]));
    }) as typeof fetch;
    const swap = new AltQuickSwap({ fetch: fetchStub, affiliateId: 'smirk' });
    await swap.start({ quote: await quoteFor(swap), toAddress: WOW_ADDRESS, refundAddress: BTC_REFUND });
    assert.equal(seen.affiliateId, 'smirk');
  });

  it('refuses to start without a destination or a refund address', async () => {
    const { swap } = venue();
    const quote = await quoteFor(swap);
    await rejectsWith(swap.start({ quote, refundAddress: BTC_REFUND }), 'not_implemented');
    await rejectsWith(swap.start({ quote, toAddress: WOW_ADDRESS }), 'not_implemented');
    await rejectsWith(swap.start({ quote, toAddress: 'short', refundAddress: BTC_REFUND }), 'not_implemented');
  });

  it('refuses a trade response that has no deposit address', async () => {
    const { swap } = venue({ '/swap/api/v1/trade': () => new Response(JSON.stringify({ uuid: 'u-3' })) });
    await rejectsWith(
      swap.start({ quote: await quoteFor(swap), toAddress: WOW_ADDRESS, refundAddress: BTC_REFUND }),
      'network_error',
    );
  });

  it('turns an AltQuick validation error into a message that names the fields', async () => {
    const { swap } = venue({
      '/swap/api/v1/trade': () =>
        new Response(JSON.stringify({ errors: { toAddress: 'The toAddress field is required!' } }), { status: 422 }),
    });
    await assert.rejects(
      swap.start({ quote: await quoteFor(swap), toAddress: WOW_ADDRESS, refundAddress: BTC_REFUND }),
      (e: unknown) => (e as SwapError).code === 'network_error' && /toAddress/.test((e as Error).message),
    );
  });
});

describe('AltQuickSwap status', () => {
  const statusOf = (trade: object) => venue({ '/swap/api/v1/trade/': () => new Response(JSON.stringify(trade)) }).swap.status('u');

  it('is awaiting deposit until a deposit exists', async () => {
    assert.deepEqual(await statusOf({ state: 'awaitingDeposit' }), { state: 'pending', reason: 'awaiting_deposit' });
  });

  it('is awaiting confirmations while the deposit is unconfirmed', async () => {
    const s = await statusOf({ state: 'awaitingDeposit', Deposit: { state: 'Pending', confirmations: 0 } });
    assert.deepEqual(s, { state: 'pending', reason: 'awaiting_confirmations' });
  });

  it('is in progress once the deposit confirms', async () => {
    const s = await statusOf({ state: 'awaitingDeposit', Deposit: { state: 'depositConfirmed' }, Sell: {} });
    assert.deepEqual(s, { state: 'pending', reason: 'in_progress' });
  });

  it('reports completion with the payout txid and amount in atomic units', async () => {
    const s = await statusOf({
      state: 'tradeComplete',
      toCoin: 'WOW',
      Withdraw: { state: 'Complete', amount: '1234.5', txid: 'abc' },
    });
    assert.equal(s.state, 'completed');
    if (s.state === 'completed') {
      assert.equal(s.outboundTxId, 'abc');
      assert.equal(toNumber(s.toAmount, 'wow'), 1234.5);
    }
  });

  it('reports a refund', async () => {
    assert.equal((await statusOf({ state: 'refunded' })).state, 'refunded');
  });

  it('never reports an unknown state as progress', async () => {
    assert.equal((await statusOf({ state: 'somethingNew' })).state, 'failed');
  });

  it('gives up on a hung gateway instead of waiting forever', async () => {
    const hang = (() => new Promise<Response>(() => {})) as unknown as Handler;
    const { swap } = venue({ '/swap/api/v1/trade/': hang });
    await rejectsWith(swap.status('unknown-uuid'), 'network_error');
  });
});
