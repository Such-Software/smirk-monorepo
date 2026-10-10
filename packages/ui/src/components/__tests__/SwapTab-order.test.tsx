/**
 * The Swap tab lists providers the wallet server offers with the live ones,
 * right after Trocador, and never as "Paused": live, a "Tap to check" target,
 * or "Unavailable now". Coming-soon routes follow. A provider the server does
 * not offer is not listed at all, and Trocador always is. The v0.3.1 release
 * candidate put THORChain and NonLogs after three coming-soon cards, and
 * NonLogs as paused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { render } from 'preact-render-to-string';
import { InMemoryStorage, RouteController, SessionStateStore } from '@smirk/core';

import { StateProvider } from '../../state/hooks';
import { SwapTab, swapProviderCards, type ProviderHandlers } from '../SwapTab';

const noop = async () => {
  throw new Error('not in this test');
};
const handlers = (over: Partial<ProviderHandlers>): ProviderHandlers => ({
  fromAssets: [],
  toAssets: [],
  onQuote: noop,
  onConfirm: noop,
  ...over,
});

const ids = (cards: ReturnType<typeof swapProviderCards>) => cards.map((c) => c.id);
const comingSoon = ['native_atomic', 'p2p_nostr', 'serai'];

test('offered providers come right after Trocador, before coming-soon routes', () => {
  const cards = swapProviderCards(
    handlers({ onCheck: () => {}, unavailableReason: 'Tap to check whether THORChain is live.' }),
    handlers({ unavailableReason: 'Checking NonLogs…' }),
  );
  assert.deepEqual(ids(cards), ['trocador', 'thorchain', 'nonlogs', ...comingSoon]);
  const thor = cards.find((c) => c.id === 'thorchain')!;
  assert.equal(thor.badge, 'Tap to check');
  assert.equal(thor.checkable, true);
  assert.equal(cards.find((c) => c.id === 'nonlogs')!.badge, 'Unavailable now');
  for (const c of cards) assert.notEqual(c.badge, 'Paused', `${c.id} must not read as paused`);
});

test('live providers are active with their tickers and no badge', () => {
  const cards = swapProviderCards(
    handlers({ fromAssets: ['btc', 'ltc'], toAssets: ['btc', 'ltc'] }),
    handlers({ fromAssets: ['btc', 'xmr'], toAssets: ['btc', 'xmr'] }),
  );
  assert.deepEqual(ids(cards).slice(0, 3), ['trocador', 'thorchain', 'nonlogs']);
  for (const id of ['thorchain', 'nonlogs']) {
    const c = cards.find((x) => x.id === id)!;
    assert.equal(c.status, 'active');
    assert.equal(c.badge, undefined);
    assert.match(c.blurb, /Live now: /);
  }
});

test('providers the wallet server does not offer are not listed; Trocador always is', () => {
  const cards = swapProviderCards(
    handlers({ offered: false, unavailableReason: 'Turned off by this wallet server.' }),
    handlers({ offered: false }),
  );
  assert.deepEqual(ids(cards), ['trocador', ...comingSoon]);
  for (const c of cards) assert.notEqual(c.badge, 'Paused', `${c.id} must not read as paused`);
});

test('one provider off and one offered: only the offered one is listed', () => {
  const cards = swapProviderCards(
    handlers({ onCheck: () => {}, unavailableReason: 'Tap to check.' }),
    handlers({ offered: false }),
  );
  assert.deepEqual(ids(cards), ['trocador', 'thorchain', ...comingSoon]);
  assert.equal(cards.find((c) => c.id === 'thorchain')!.badge, 'Tap to check');
});

test('a provider the consumer did not wire at all is not listed', () => {
  const cards = swapProviderCards(undefined, undefined);
  assert.deepEqual(ids(cards), ['trocador', ...comingSoon]);
});

test('coming-soon copy promises no version numbers', () => {
  const cards = swapProviderCards(undefined, undefined);
  for (const id of comingSoon) {
    const c = cards.find((x) => x.id === id)!;
    assert.equal(c.badge, 'Soon');
    assert.doesNotMatch(c.statusNote ?? '', /v\d+\.\d+/, `${id} names a version`);
  }
});

test('the rendered tab shows that order', () => {
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
        thorchain: handlers({ onCheck: () => {}, unavailableReason: 'Tap to check.' }),
        nonlogs: handlers({ unavailableReason: 'No pair for this wallet right now.' }),
      }),
    ),
  );
  store.destroy();
  const at = (id: string) => html.indexOf(`data-testid="swap-provider-${id}"`);
  const order = ['trocador', 'thorchain', 'nonlogs', ...comingSoon].map(at);
  assert.ok(order.every((x) => x >= 0), 'every card rendered');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'rendered in display order');
  assert.doesNotMatch(html, />Paused</);
});

test('the rendered tab omits a provider the wallet server turned off', () => {
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
        thorchain: handlers({ onCheck: () => {}, unavailableReason: 'Tap to check.' }),
        nonlogs: handlers({ offered: false, unavailableReason: 'Not offered by this wallet server.' }),
      }),
    ),
  );
  store.destroy();
  assert.match(html, /data-testid="swap-provider-trocador"/);
  assert.match(html, /data-testid="swap-provider-thorchain"/);
  assert.doesNotMatch(html, /data-testid="swap-provider-nonlogs"/);
  assert.doesNotMatch(html, />Paused</);
});
