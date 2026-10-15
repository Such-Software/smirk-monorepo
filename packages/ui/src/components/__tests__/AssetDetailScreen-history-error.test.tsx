/**
 * A coin screen whose chain history failed to load says so, with a retry.
 *
 * In the v0.3.1 live run every BTC and LTC wallet read "No activity yet",
 * funded ones included: the history read threw, and the shell turned that
 * into an empty list. An empty list and a failed read are different facts,
 * and only the first may render as the empty state.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { h, render as mount } from 'preact';
import { render } from 'preact-render-to-string';

import { AssetDetailScreen, type AssetDetailTxRow } from '../AssetDetailScreen';
import { byTestId, click, installMiniDom, miniDocument } from './mini-dom';

const TIP: AssetDetailTxRow = {
  kind: 'tip-received',
  tipId: 'tip-1',
  amountAtomic: 4_000n,
  ticker: 'BTC',
  counterparty: 'anonymous',
  timestamp: '2026-10-14T18:00:00Z',
};

const screen = (props: Partial<Parameters<typeof AssetDetailScreen>[0]> = {}) =>
  h(AssetDetailScreen, {
    assetId: 'btc',
    balanceAtomic: 9_874n,
    history: [],
    onBack: () => {},
    ...props,
  });

const has = (html: string, testid: string) => html.includes(`data-testid="${testid}"`);

test('an empty history with no error is the empty state', () => {
  const html = render(screen());
  assert.ok(has(html, 'asset-detail-history-empty'));
  assert.ok(!has(html, 'asset-detail-history-error'));
});

test('a failed history read is an error, never the empty state', () => {
  const html = render(screen({ historyError: 'Cannot convert null to a BigInt', onRetryHistory: () => {} }));
  assert.ok(has(html, 'asset-detail-history-error'));
  assert.ok(has(html, 'asset-detail-history-retry'));
  assert.ok(!has(html, 'asset-detail-history-empty'));
});

test('the error reports the cause it caught', () => {
  const html = render(screen({ historyError: 'upstream node unavailable', onRetryHistory: () => {} }));
  assert.match(html, /upstream node unavailable/);
});

test('rows from elsewhere still render beneath the error', () => {
  const html = render(screen({ history: [TIP], historyError: 'timed out', onRetryHistory: () => {} }));
  assert.ok(has(html, 'asset-detail-history-error'));
  assert.ok(!has(html, 'asset-detail-history-empty'));
  assert.match(html, /anonymous/);
});

test('no error is shown while a retry is loading', () => {
  const html = render(screen({ loading: true, historyError: 'timed out', onRetryHistory: () => {} }));
  assert.ok(!has(html, 'asset-detail-history-error'));
});

let restore: () => void = () => {};
beforeEach(() => {
  restore = installMiniDom();
});
afterEach(() => restore());

test('Try again reads the history again', () => {
  let retries = 0;
  const root = miniDocument.createElement('div');
  mount(screen({ historyError: 'timed out', onRetryHistory: () => retries++ }), root as never);
  const retry = byTestId(root, 'asset-detail-history-retry');
  assert.ok(retry, 'a retry is offered');
  assert.ok(click(retry));
  assert.equal(retries, 1);
  mount(null, root as never);
});
