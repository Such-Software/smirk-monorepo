/**
 * The Swap tab's honesty about third parties and fees.
 *
 * - The THORChain card does not ask THORChain anything until tapped: with an
 *   `onCheck` it is a tap target saying what the tap contacts, not a "Paused"
 *   card fed by a request made on mount.
 * - The WOW/GRIN panel offers prices on a tap that names neroswap.com.
 * - The quote's fee row is in the asset the provider charges, marked as part of
 *   the estimate, never "≈ 0 BTC" for a THORChain fee taken in LTC.
 * - The deposit step shows the binding receive estimate before the user signs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { render } from 'preact-render-to-string';
import { InMemoryStorage, RouteController, SessionStateStore } from '@smirk/core';

import { StateProvider } from '../../state/hooks';
import { DepositStep, QuoteStep, SwapTab, type SwapQuoteSummary, type ThorchainHandlers } from '../SwapTab';
import { WhereToTrade } from '../WhereToTrade';

const noop = async () => {
  throw new Error('not in this test');
};

function swapTab(thorchain: Partial<ThorchainHandlers> | undefined, loadTradePrices?: () => Promise<never>) {
  const store = new SessionStateStore(new InMemoryStorage());
  const router = new RouteController(store);
  const html = render(
    h(
      StateProvider,
      { store, router },
      h(SwapTab, {
        fromAssets: [],
        toAssets: [],
        resolveBalance: () => null,
        parseAmount: () => null,
        onTrocadorQuote: noop,
        onTrocadorConfirm: noop,
        onOpenSend: () => {},
        ...(thorchain
          ? { thorchain: { fromAssets: [], toAssets: [], onQuote: noop, onConfirm: noop, ...thorchain } }
          : {}),
        ...(loadTradePrices ? { loadTradePrices } : {}),
      }),
    ),
  );
  store.destroy();
  return html;
}

/** The provider row for `id`, as rendered. */
function card(html: string, id: string): string {
  const start = html.indexOf(`data-testid="swap-provider-${id}"`);
  assert.ok(start >= 0, `${id} card rendered`);
  const open = html.lastIndexOf('<button', start);
  return html.slice(open, html.indexOf('</button>', start));
}

test('an unchecked THORChain card is a tap target that names what the tap contacts', () => {
  let checks = 0;
  const html = swapTab({
    unavailableReason: 'Tap to check whether THORChain is live. This asks its public gateway (gateway.example), which sees your IP address.',
    onCheck: () => {
      checks += 1;
    },
  });
  const thor = card(html, 'thorchain');
  assert.doesNotMatch(thor, /disabled/);
  assert.match(thor, /gateway\.example/);
  assert.doesNotMatch(thor, />Paused</);
  assert.equal(checks, 0, 'rendering the tab asks nothing');
});

test('a THORChain card the wallet server turned off is disabled and reads as paused', () => {
  const thor = card(swapTab({ offered: false, unavailableReason: 'Turned off by this wallet server.' }), 'thorchain');
  assert.match(thor, /disabled/);
  assert.match(thor, />Paused</);
});

test('an offered THORChain card with no live pair and no check is unavailable, not paused', () => {
  const thor = card(swapTab({ unavailableReason: 'No live pair right now.' }), 'thorchain');
  assert.match(thor, /disabled/);
  assert.match(thor, />Unavailable now</);
  assert.doesNotMatch(thor, />Paused</);
});

test('the WOW/GRIN panel offers live prices on a tap that names neroswap.com', () => {
  let loads = 0;
  const loadPrices = async () => {
    loads += 1;
    return [];
  };
  const html = render(h(WhereToTrade, { loadPrices }));
  assert.match(html, /data-testid="swap-where-to-trade-show-prices"/);
  assert.match(html, /neroswap\.com/);
  assert.equal(loads, 0);
});

const thorQuote: SwapQuoteSummary = {
  tradeId: '',
  fromAsset: 'btc',
  toAsset: 'ltc',
  fromAmountAtomic: '1000000',
  toAmountEstimateAtomic: '1245633282',
  feeEstimateAtomic: '3164706',
  feeAssetId: 'ltc',
  feeIncludedInEstimate: true,
  provider: 'thorchain',
  etaSeconds: 600,
  expiresAtMs: Date.now() + 600_000,
};

function quoteStep(quote: SwapQuoteSummary): string {
  return render(
    h(QuoteStep, {
      quote,
      toAddress: '',
      refundAddress: '',
      refundAddressAutoFilledFor: undefined,
      onPatch: () => {},
      onReQuote: () => {},
      onConfirm: async () => {},
    }),
  );
}

function feeRow(html: string): string {
  const start = html.indexOf('data-testid="swap-quote-fee"');
  assert.ok(start >= 0);
  return html.slice(start, html.indexOf('</span>', start)).replace(/<!--.*?-->/g, '');
}

test('a THORChain fee reads in LTC, as part of the estimate, never as zero BTC', () => {
  const fee = feeRow(quoteStep(thorQuote));
  assert.match(fee, /0\.03164706/);
  assert.match(fee, /LTC/);
  assert.doesNotMatch(fee, /BTC/);
  assert.match(fee, /included/);
});

test('a provider that charges in the source asset keeps its fee row as it was', () => {
  const { feeAssetId: _a, feeIncludedInEstimate: _b, ...rest } = thorQuote;
  const fee = feeRow(quoteStep({ ...rest, provider: 'trocador', feeEstimateAtomic: '1500' }));
  assert.match(fee, /BTC/);
  assert.doesNotMatch(fee, /included/);
});

test('the deposit step shows what this deposit was quoted to deliver', () => {
  const html = render(
    h(DepositStep, {
      swap: {
        id: 'thorchain:1',
        fromAsset: 'btc',
        toAsset: 'ltc',
        fromAmountAtomic: '1000000',
        toAmountEstimateAtomic: '1145982619',
        depositAddress: 'bc1qvault',
        provider: 'thorchain',
        memo: '=:l:ltc1qdest:1111603140',
        depositBeforeMs: Date.now() + 600_000,
        state: { state: 'pending', reason: 'awaiting_deposit' },
      },
      onOpenSend: () => {},
      onContinue: () => {},
    }),
  );
  const start = html.indexOf('data-testid="swap-deposit-receive"');
  assert.ok(start >= 0, 'receive row rendered');
  assert.match(html.slice(start, html.indexOf('</span>', start)), /11\.45982619\s*LTC/);
});
