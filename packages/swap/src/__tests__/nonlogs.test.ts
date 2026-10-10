import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  NonlogsSwap,
  NonlogsBackendError,
  mapStatus,
  swappable,
  atomicToDecimal,
  decimalToAtomic,
  type NonlogsBackend,
  type NonlogsQuoteData,
} from '../nonlogs';

const here = dirname(fileURLToPath(import.meta.url));
const book = (pair: string): unknown => {
  try {
    return JSON.parse(readFileSync(join(here, 'fixtures/nonlogs', `ob-${pair}.json`), 'utf8'));
  } catch {
    return { pair, bids: [], asks: [] };
  }
};

/** A fake of our backend's /swaps/nonlogs routes, over recorded books. */
function fakeBackend(overrides: Partial<NonlogsBackend> = {}) {
  const calls = { quote: [] as Record<string, string>[], create: [] as Record<string, string>[], books: [] as string[] };
  const backend: NonlogsBackend = {
    assets: async () => ({
      creation_enabled: true,
      assets: [
        { symbol: 'BTC', network: 'bitcoin' },
        { symbol: 'WOW', network: 'wownero' },
        { symbol: 'XMR', network: 'monero', available: false },
      ],
    }),
    quote: async (body) => {
      calls.quote.push(body);
      return { estimated_receive: '8400.5', route: ['WOW-BTC'], fees: [{ kind: 'network', symbol: 'WOW', amount: '1.5' }] };
    },
    create: async (body) => {
      calls.create.push(body);
      return {
        id: 'sw42',
        deposit_address: 'bc1qdeposit',
        address_tag: null,
        swap_url: 'https://nonlogs.io/swap/status#ABCDEFGHIJKLMN',
        funding_expires_at: '2026-10-08T16:00:00Z',
      };
    },
    status: async () => ({}),
    orderbook: async (pair) => {
      calls.books.push(pair);
      return book(pair);
    },
    ...overrides,
  };
  return { backend, calls };
}

test('amounts convert between atomic units and decimals exactly', () => {
  assert.equal(atomicToDecimal('100000', 8), '0.001');
  assert.equal(atomicToDecimal('100000000000', 11), '1');
  assert.equal(decimalToAtomic('0.001', 8), '100000');
  assert.equal(decimalToAtomic('8400.5', 11), '840050000000000');
});

test('GRIN is not offered in-app, and only listed coins count as available', async () => {
  const { backend } = fakeBackend();
  const s = new NonlogsSwap({ backend });
  assert.equal(s.supports('grin', 'btc'), false);
  assert.equal(s.supports('btc', 'wow'), true);
  assert.deepEqual(await s.availableAssets(), ['btc', 'wow']);
});

test('a quote carries the venue estimate and a walk of the reported route', async () => {
  const { backend, calls } = fakeBackend();
  const s = new NonlogsSwap({ backend, randomUUID: () => 'req-1' });
  const q = await s.quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: '100000' });
  assert.deepEqual(calls.quote[0], {
    from: 'BTC',
    to: 'WOW',
    amount: '0.001',
    from_network: 'bitcoin',
    to_network: 'wownero',
  });
  assert.deepEqual(calls.books, ['WOW-BTC']);
  assert.equal(q.toAmountEstimate, '840050000000000', 'the venue estimate, in WOW atomic units');
  const d = q.implementationData as NonlogsQuoteData;
  assert.equal(d.clientRequestId, 'req-1');
  const a = d.analysis!;
  assert.deepEqual(a.route, ['WOW-BTC']);
  // 8578.083... from the books, less 0.15 and 0.8 percent, less 1.5 WOW.
  const expected = 8578.083333333 * 0.9985 * 0.992 - 1.5;
  assert.ok(Math.abs(Number(a.expectedReceive) - expected) < 0.01, a.expectedReceive);
  assert.equal(a.exceedsDepth, false);
  assert.equal(a.venueEstimate, '8400.5');
  // 8400.5 versus about 8495: under 2 percent apart, so one number is enough.
  assert.equal(a.estimatesDiffer, false);
});

test('materially different estimates are both kept for display', async () => {
  const { backend } = fakeBackend({ quote: async () => ({ estimated_receive: '9500', route: ['WOW-BTC'] }) });
  const q = await new NonlogsSwap({ backend }).quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: '100000' });
  const a = (q.implementationData as NonlogsQuoteData).analysis!;
  assert.equal(a.estimatesDiffer, true);
  assert.equal(a.venueEstimate, '9500');
});

test('without a reported route the route is planned, and LTC finds no liquidity', async () => {
  const { backend } = fakeBackend({ quote: async () => ({}) });
  await assert.rejects(
    new NonlogsSwap({ backend }).quote({ fromAsset: 'ltc', toAsset: 'btc', fromAmount: '50000000' }),
    (e: { code?: string }) => e.code === 'provider_unavailable',
  );
});

test('an order larger than the books is flagged, with the most the books can fill', async () => {
  const { backend } = fakeBackend();
  const q = await new NonlogsSwap({ backend }).quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: '500000000' });
  const a = (q.implementationData as NonlogsQuoteData).analysis!;
  assert.equal(a.exceedsDepth, true);
  assert.equal(a.warning, 'exceeds_depth');
  assert.ok(Number(a.maxInput) > 1 && Number(a.maxInput) < 2, a.maxInput);
});

test('start sends the wallet addresses and the quote request id, and a retry reuses it', async () => {
  const { backend, calls } = fakeBackend();
  const s = new NonlogsSwap({ backend, randomUUID: () => 'req-7' });
  const quote = await s.quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: '100000' });
  const started = await s.start({ quote, toAddress: 'Wo-own', refundAddress: 'bc1-own' });
  await s.start({ quote, toAddress: 'Wo-own', refundAddress: 'bc1-own' });
  assert.equal(started.id, 'sw42');
  assert.equal(started.depositAddress, 'bc1qdeposit');
  assert.equal(started.statusUrl, 'https://nonlogs.io/swap/status#ABCDEFGHIJKLMN');
  assert.equal(started.fundingExpiresAtMs, Date.parse('2026-10-08T16:00:00Z'));
  assert.equal(calls.create.length, 2);
  assert.equal(calls.create[0]!.client_request_id, 'req-7');
  assert.equal(calls.create[1]!.client_request_id, 'req-7', 'same id on retry: the same swap comes back');
  assert.equal(calls.create[0]!.payout_address, 'Wo-own');
  assert.equal(calls.create[0]!.refund_address, 'bc1-own');
});

test('a deposit that needs a tag is refused, not sent without one', async () => {
  const { backend } = fakeBackend({ create: async () => ({ id: 'x', deposit_address: 'addr', address_tag: '12345' }) });
  const s = new NonlogsSwap({ backend });
  const quote = await s.quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: '100000' });
  await assert.rejects(s.start({ quote, toAddress: 'a', refundAddress: 'b' }), /tag/);
});

test('an uncertain creation tells the user that confirming again is safe', async () => {
  const { backend } = fakeBackend({
    create: async () => {
      throw new NonlogsBackendError('uncertain', 'SWAP_UNCERTAIN', 503);
    },
  });
  const s = new NonlogsSwap({ backend });
  const quote = await s.quote({ fromAsset: 'btc', toAsset: 'wow', fromAmount: '100000' });
  await assert.rejects(s.start({ quote, toAddress: 'a', refundAddress: 'b' }), (e: { code?: string; message: string }) =>
    e.code === 'network_error' && /same swap/.test(e.message),
  );
});

test('status: waiting, confirming, converting, paid, refunded, expired', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');
  assert.deepEqual(mapStatus({ payments: [] }, now, 11), { state: 'pending', reason: 'awaiting_deposit' });
  assert.deepEqual(
    mapStatus({ payments: [{ confirmations: 1, required_confirmations: 2 }] }, now, 11),
    { state: 'pending', reason: 'awaiting_confirmations' },
  );
  assert.deepEqual(mapStatus({ payments: [{ confirmations: 3, required_confirmations: 2 }] }, now, 11), {
    state: 'pending',
    reason: 'in_progress',
  });
  // A partial fill pays some out and refunds the rest: it completed.
  assert.deepEqual(
    mapStatus(
      {
        payments: [{}],
        payouts: [{ tx_hash: 'out1', amount: '100.5' }],
        refunds: [{ tx_hash: 'ref1', amount: '0.0001' }],
      },
      now,
      11,
    ),
    { state: 'completed', outboundTxId: 'out1', toAmount: '10050000000000' },
  );
  assert.equal(mapStatus({ payments: [{}], refunds: [{ tx_hash: 'r' }] }, now, 11).state, 'refunded');
  assert.equal(mapStatus({ payments: [], funding_expires_at: '2026-10-07T00:00:00Z' }, now, 11).state, 'failed');
});

// NonLogs' own guest-swap catalogue (recorded 2026-10-10 from
// /api/guest-swaps/catalog, trimmed): nested under `swap`, flag `enabled`.
// The v0.3.1 RC read only a top-level `creation_enabled`, so a body shaped like
// this offered no coins at all.
const nestedCatalogue = {
  swap: {
    enabled: true,
    assets: [
      { id: 4, symbol: 'BTC', network: 'bitcoin', available: true, supported: true },
      { id: 9, symbol: 'LTC', network: 'litecoin', available: true, supported: true },
      { id: 7, symbol: 'XMR', network: 'monero', available: true, supported: true },
      { id: 8, symbol: 'WOW', network: 'wownero', available: false, supported: true },
      { id: 6, symbol: 'GRIN', network: 'grin', available: false, supported: false },
    ],
    defaults: { from_id: 4, to_id: 7 },
  },
  csrf: 'not-a-secret-fixture',
};

test('swappable reads the nested catalogue NonLogs actually serves', () => {
  const { symbols, networks } = swappable(nestedCatalogue);
  assert.deepEqual([...symbols].sort(), ['BTC', 'LTC', 'XMR']);
  assert.equal(networks['XMR'], 'monero');
});

test('swappable stays closed on every shape without an explicit true flag', () => {
  const assets = [{ symbol: 'BTC', available: true }];
  for (const body of [
    { swap: { enabled: false, assets } },
    { swap: { assets } },
    { data: { creation_enabled: 'yes', assets } },
    { enabled: true },
    [],
    null,
  ]) {
    assert.equal(swappable(body).symbols.size, 0, `opened on ${JSON.stringify(body)}`);
  }
  assert.deepEqual([...swappable({ creation_enabled: true, assets }).symbols], ['BTC']);
  assert.deepEqual([...swappable({ data: { creation_enabled: true, assets } }).symbols], ['BTC']);
});

test('an unsupported coin is never swappable even if marked available', () => {
  const body = { creation_enabled: true, assets: [{ symbol: 'GRIN', available: true, supported: false }] };
  assert.equal(swappable(body).symbols.size, 0);
});

test('availableAssets offers our coins from the nested catalogue', async () => {
  const { backend } = fakeBackend({ assets: async () => nestedCatalogue });
  const swap = new NonlogsSwap({ backend });
  assert.deepEqual((await swap.availableAssets()).sort(), ['btc', 'ltc', 'xmr']);
});
