/**
 * Buying premium: properties, not wording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planPeriodLabel,
  planLabel,
  planName,
  nextPremiumPollDelayMs,
  premiumActivationOutcome,
  PREMIUM_POLL_FAST_MS,
  PREMIUM_POLL_SLOW_MS,
  PREMIUM_POLL_FAST_WINDOW_MS,
  PREMIUM_POLL_MAX_MS,
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

test('two plans with the same period and currency get different labels', () => {
  // Production sells a founding promo beside the standing price, both 1 year.
  const founding = planLabel({ id: 'founding', days: 365, amount: '5' }, 'USD');
  const year = planLabel({ id: 'year', days: 365, amount: '15' }, 'USD');
  assert.notEqual(founding, year);
  const withoutAmounts = (l: string) => l.replace(/\d+/g, '');
  assert.notEqual(withoutAmounts(founding), withoutAmounts(year));
});

test('a plan label carries its name, period and price', () => {
  const label = planLabel({ id: 'founding', days: 365, amount: '5' }, 'USD');
  assert.ok(label.includes(planName({ id: 'founding', days: 365, amount: '5' })), label);
  assert.ok(label.includes(planPeriodLabel(365)), label);
  assert.ok(label.includes('5') && label.includes('USD'), label);
});

test("the backend's own plan label wins over the id", () => {
  const name = planName({ id: 'founding', days: 365, amount: '5', label: 'Early bird' });
  assert.equal(name, 'Early bird');
});

test('an unknown plan id still gets a non-empty name derived from it', () => {
  const name = planName({ id: 'half_year', days: 182, amount: '9' });
  assert.ok(name.length > 0);
  assert.match(name.toLowerCase(), /half/);
  assert.ok(planName({ id: '  ', days: 1, amount: '1', label: ' ' }).length > 0);
});

test('automatic checks run fast first, then slower, then stop', () => {
  const t0 = 5_000_000;
  assert.equal(nextPremiumPollDelayMs(t0, t0), PREMIUM_POLL_FAST_MS);
  const slow = nextPremiumPollDelayMs(t0, t0 + PREMIUM_POLL_FAST_WINDOW_MS);
  assert.equal(slow, PREMIUM_POLL_SLOW_MS);
  assert.equal(nextPremiumPollDelayMs(t0, t0 + PREMIUM_POLL_MAX_MS), null);
  assert.equal(nextPremiumPollDelayMs(t0, t0 + PREMIUM_POLL_MAX_MS + 1), null);
});

test('no automatic check is ever scheduled past the cap', () => {
  const t0 = 0;
  for (let age = 0; age < PREMIUM_POLL_MAX_MS; age += 7_919) {
    const d = nextPremiumPollDelayMs(t0, age);
    assert.ok(d !== null && d > 0, String(age));
    assert.ok(age + d <= PREMIUM_POLL_MAX_MS, String(age));
  }
});

test('a clock earlier than the invoice does not start checking', () => {
  assert.equal(nextPremiumPollDelayMs(10_000, 9_000), null);
});

test('only invoices that can never activate stop automatic checking', () => {
  // The backend's actual refusals (src/api/premium.rs activate).
  assert.equal(premiumActivationOutcome('Payment not yet confirmed. Complete the payment and retry.'), 'waiting');
  assert.equal(
    premiumActivationOutcome("This invoice's payment method is currently unavailable. Try again later."),
    'waiting',
  );
  assert.equal(premiumActivationOutcome(undefined), 'waiting');
  assert.equal(premiumActivationOutcome('Unknown or invalid premium invoice.'), 'final');
  assert.equal(premiumActivationOutcome('This premium invoice has already been used.'), 'final');
});
