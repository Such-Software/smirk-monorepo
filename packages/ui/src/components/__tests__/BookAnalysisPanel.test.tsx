/**
 * The order-book panel beside an order-book venue's quote. What must hold:
 * the user sees the expected receipt and impact, is warned loudly when the
 * order outgrows the visible book or moves the price a lot, and sees both
 * estimates when the venue's and the book's disagree.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { render } from 'preact-render-to-string';

import { BookAnalysisPanel, type BookAnalysisView } from '../SwapTab';

const base: BookAnalysisView = {
  route: ['WOW-BTC'],
  expectedReceive: '8495.12',
  priceImpact: 0.012,
  maxInput: '1.56',
  exceedsDepth: false,
  warning: 'none',
  venueEstimate: '8400.5',
  estimatesDiffer: false,
  feesModelled: '0.15% taker per leg (1), 0.8% convenience fee',
};

const html = (a: BookAnalysisView) => render(h(BookAnalysisPanel, { analysis: a, fromTicker: 'BTC', toTicker: 'WOW' }));

describe('BookAnalysisPanel', () => {
  it('shows the expected receipt, impact, depth and route, with no warning for a small order', () => {
    const out = html(base);
    assert.match(out, /8495\.12 WOW/);
    assert.match(out, /1\.2%/);
    assert.match(out, /up to 1\.56 BTC/);
    assert.match(out, /WOW-BTC/);
    assert.doesNotMatch(out, /larger than the visible order book|High price impact/);
    assert.doesNotMatch(out, /Venue&#39;s own estimate|Venue's own estimate/, 'one number when the estimates agree');
  });

  it('warns when the order is larger than the book, naming the most that fills', () => {
    const out = html({ ...base, exceedsDepth: true, warning: 'exceeds_depth' });
    assert.match(out, /larger than the visible order book/);
    assert.match(out, /At most 1\.56 BTC fills/);
  });

  it('warns strongly on high impact and mildly on noticeable impact', () => {
    assert.match(html({ ...base, priceImpact: 0.14, warning: 'strong' }), /High price impact \(14\.0%\)/);
    assert.match(html({ ...base, priceImpact: 0.04, warning: 'notice' }), /Noticeable price impact \(4\.0%\)/);
  });

  it('shows both estimates when they differ materially, and says neither is guaranteed', () => {
    const out = html({ ...base, venueEstimate: '9500', estimatesDiffer: true });
    assert.match(out, /9500 WOW/);
    assert.match(out, /8495\.12 WOW/);
    assert.match(out, /Neither is guaranteed/);
  });
});
