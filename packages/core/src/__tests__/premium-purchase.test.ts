/**
 * Buying premium: properties, not wording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planPeriodLabel,
  offeredRails,
  railLabel,
  isPendingRedeemable,
  isCheckoutUrl,
  PENDING_PREMIUM_MAX_AGE_MS,
  type PendingPremiumInvoice,
} from '../premium-purchase';

test('a whole number of years reads as years, anything else as days', () => {
  assert.match(planPeriodLabel(365), /year/);
  assert.match(planPeriodLabel(730), /2/);
  assert.doesNotMatch(planPeriodLabel(90), /year/);
  assert.doesNotMatch(planPeriodLabel(366), /year/);
});

test('a backend without rails is still payable, with no rail sent', () => {
  // Sending a guessed rail id to an older backend would be refused.
  for (const none of [undefined, []]) {
    const offered = offeredRails(none);
    assert.equal(offered.length, 1);
    assert.equal(offered[0]?.id, null);
  }
});

test('every advertised rail is offered, in the backend order', () => {
  const offered = offeredRails([
    { id: 'btcpay', assets: ['BTC', 'LTC'] },
    { id: 'xmrcheckout', assets: ['XMR'] },
  ]);
  assert.deepEqual(
    offered.map((o) => o.id),
    ['btcpay', 'xmrcheckout'],
  );
});

test('a rail label names every asset it takes', () => {
  const label = railLabel({ id: 'btcpay', assets: ['btc', 'LTC', 'grin'] });
  for (const a of ['BTC', 'LTC', 'GRIN']) assert.ok(label.includes(a), label);
});

test('a rail with no declared assets is identified, not left blank', () => {
  assert.ok(railLabel({ id: 'btcpay', assets: [] }).length > 0);
});

const pending = (over: Partial<PendingPremiumInvoice> = {}): PendingPremiumInvoice => ({
  invoiceId: 'inv1',
  planId: 'founding',
  rail: 'btcpay',
  payTo: 'https://pay.example/i/inv1',
  apiBase: 'https://api.a',
  createdAt: 1_000_000,
  ...over,
});

test('a pending invoice is only redeemable on the backend that minted it', () => {
  assert.equal(isPendingRedeemable(pending(), 'https://api.a', 1_000_001), true);
  assert.equal(isPendingRedeemable(pending(), 'https://api.b', 1_000_001), false);
});

test('a pending invoice ages out, and a clock that went backwards does not keep it', () => {
  const p = pending();
  assert.equal(isPendingRedeemable(p, 'https://api.a', p.createdAt + PENDING_PREMIUM_MAX_AGE_MS), true);
  assert.equal(isPendingRedeemable(p, 'https://api.a', p.createdAt + PENDING_PREMIUM_MAX_AGE_MS + 1), false);
  assert.equal(isPendingRedeemable(p, 'https://api.a', p.createdAt - 1), false);
});

test('nothing remembered is nothing to redeem', () => {
  assert.equal(isPendingRedeemable(null, 'https://api.a', 1), false);
  assert.equal(isPendingRedeemable(pending({ invoiceId: '' }), 'https://api.a', 1_000_001), false);
});

test('only a real URL is opened as a checkout', () => {
  assert.equal(isCheckoutUrl('https://btcpay.such.software/i/abc'), true);
  assert.equal(isCheckoutUrl('4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx'), false);
  assert.equal(isCheckoutUrl('javascript:alert(1)'), false);
});
