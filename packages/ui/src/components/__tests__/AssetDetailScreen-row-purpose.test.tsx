/**
 * A chain row that stands for a swap deposit keeps saying so, and its sheet
 * routes "swap status" and "explorer" to different places.
 *
 * While a deposit is unconfirmed the wallet lists one row for it. Once the
 * chain lists the same txid that row is the chain row, which offers both the
 * swap status and the block explorer; both used to go through one callback
 * that routed by row kind, so a chain row could only ever reach one of them.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { h, render as mount } from 'preact';
import { render } from 'preact-render-to-string';

import { AssetDetailScreen, type AssetDetailTxRow } from '../AssetDetailScreen';
import { buttonsByText, click, installMiniDom, miniDocument } from './mini-dom';

const DEPOSIT: AssetDetailTxRow = {
  kind: 'utxo',
  direction: 'out',
  amountAtomic: 5_154n,
  txid: '02'.repeat(32),
  heightOrPending: 'pending',
  feeAtomic: 154n,
  context: { kind: 'swap-deposit', tradeId: 'TRADE-0001-XYZ', toAsset: 'xmr', provider: 'trocador' },
};

const screen = (props: Partial<Parameters<typeof AssetDetailScreen>[0]> = {}) =>
  h(AssetDetailScreen, {
    assetId: 'btc',
    balanceAtomic: 9_874n,
    history: [DEPOSIT],
    onBack: () => {},
    ...props,
  });

test('a deposit listed by the chain names the swap in its subline', () => {
  const html = render(screen());
  assert.match(html, /swap → XMR/);
});

/** Let Preact's debounced re-render run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

let restore: () => void = () => {};
beforeEach(() => {
  restore = installMiniDom();
});
afterEach(() => restore());

test('the swap status and the explorer reach their own handlers', async () => {
  const calls: string[] = [];
  const root = miniDocument.createElement('div');
  mount(
    screen({
      hasExplorer: () => true,
      onOpenExplorer: () => calls.push('explorer'),
      onOpenSwap: () => calls.push('swap'),
    }),
    root as never,
  );
  const [row] = buttonsByText(root, /swap → XMR/);
  assert.ok(row, 'the deposit row is listed');
  assert.ok(click(row));
  await settle();
  const [swap] = buttonsByText(root, /swap status/i);
  const [explorer] = buttonsByText(root, /block explorer/i);
  assert.ok(swap && explorer, 'the sheet offers both');
  assert.ok(click(swap));
  assert.ok(click(explorer));
  assert.deepEqual(calls, ['swap', 'explorer']);
  mount(null, root as never);
  await settle();
});
