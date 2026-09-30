import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'preact-render-to-string';
import { h } from 'preact';
import { InMemoryStorage, SessionStateStore, Wizard } from '@smirk/core';
import { mustGetAsset } from '@smirk/assets';
import { prepareSendDraft } from '../send-draft';
import { UsdEstimate } from '../UsdEstimate';
import { formatApproximateUsd } from '../../format';

test('coin-detail Send initializes the destination in one persisted write', async () => {
  const storage = new InMemoryStorage();
  const store = new SessionStateStore(storage);
  const wizard = new Wizard(store, 'send', {});
  const observed: number[] = [];
  store.subscribe((state) => observed.push(state.wizards.send!.step));
  await wizard.start((current) => prepareSendDraft(current, 'ltc'));
  const opened = await wizard.snapshot();
  assert.equal(opened?.fields.fromAssetId, 'ltc');
  assert.equal(opened?.step, 1);
  assert.ok(observed.every((step) => step === 1), 'no intermediate coin chooser is persisted');
  store.destroy();
});

test('cold reopen clears a completed receipt before selecting the new coin', async () => {
  const storage = new InMemoryStorage();
  const previous = new SessionStateStore(storage);
  await previous.update((state) => {
    state.wizards.send = { step: 4, fields: { fromAssetId: 'btc', toAddress: 'old destination', lastTxid: 'old transaction' }, startedAt: 1 };
  });
  previous.destroy();
  const store = new SessionStateStore(storage);
  const wizard = new Wizard(store, 'send', {});
  // No store.load or component hydration precedes this call.
  await wizard.start((current) => prepareSendDraft(current, 'xmr'));
  const opened = await wizard.snapshot();
  assert.equal(opened?.step, 1);
  assert.equal(opened?.fields.fromAssetId, 'xmr');
  assert.equal(opened?.fields.toAddress, undefined);
  assert.equal(opened?.fields.lastTxid, undefined);
  store.destroy();
});

test('Send preserves a restored draft and interactive exchange', async () => {
  for (const fields of [
    { fromAssetId: 'ltc', toAddress: 'draft destination', amountText: '0.3' },
    { fromAssetId: 'grin', grinSlateId: 'pending slate', grinSenderContextJson: 'opaque context' },
  ]) {
    const state = { step: 3, fields, startedAt: 2 };
    assert.deepEqual(prepareSendDraft(state, 'xmr'), state);
  }
});

test('general Send keeps the coin chooser; an empty coin-detail draft skips it', () => {
  const state = { step: 0, fields: { fromAssetId: 'btc', sweep: true, feeRate: 50, previewAmountAtomic: '123', pendingContext: 'old context' }, startedAt: 3 };
  assert.equal(prepareSendDraft(state).step, 0);
  const opened = prepareSendDraft(state, 'wow');
  assert.equal(opened.step, 1);
  assert.equal(opened.fields.fromAssetId, 'wow');
  for (const field of ['sweep', 'feeRate', 'previewAmountAtomic', 'pendingContext']) {
    assert.equal(opened.fields[field], undefined, `${field} must not cross into a different asset`);
  }
});

test('USD estimate respects each asset precision and never changes atomic amounts', () => {
  for (const assetId of ['btc', 'ltc', 'xmr', 'wow', 'grin']) {
    const amount = 2n * 10n ** BigInt(mustGetAsset(assetId).decimals);
    assert.equal(formatApproximateUsd(amount, assetId, 62.5), '≈ $125.00 USD');
    assert.equal(amount, 2n * 10n ** BigInt(mustGetAsset(assetId).decimals));
  }
  assert.match(formatApproximateUsd(1n, 'xmr', 100)!, /0\.01/);
});

test('missing or invalid price is unavailable, never a zero-dollar estimate', () => {
  for (const price of [null, undefined, 0, -1, NaN, Infinity]) {
    assert.equal(formatApproximateUsd(100000000n, 'ltc', price), null);
    const html = render(h(UsdEstimate, { amount: 100000000n, assetId: 'ltc', price, testid: 'estimate' }));
    assert.ok(!html.includes('$0.00'));
    assert.match(html, /unavailable/i);
  }
  assert.equal(formatApproximateUsd(0n, 'ltc', 100), null);
  assert.equal(formatApproximateUsd(10n ** 400n, 'ltc', 100), null);
});

test('amount and review components show the same received-value estimate', () => {
  for (const testid of ['send-amount-usd', 'send-review-usd']) {
    const html = render(h(UsdEstimate, { amount: 125000000n, assetId: 'ltc', price: 80, testid }));
    assert.match(html, /\$100\.00 USD/);
    assert.ok(html.includes(testid));
  }
  assert.equal(render(h(UsdEstimate, { amount: null, assetId: 'ltc', price: 80, testid: 'estimate' })), '');
});
