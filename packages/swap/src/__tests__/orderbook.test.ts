import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  dec,
  fmt,
  walkLeg,
  walkRoute,
  planRoute,
  legsFromPairs,
  legBetween,
  maxFillableInput,
  depthWarning,
  materiallyDifferent,
  type OrderBook,
} from '../orderbook';

const here = dirname(fileURLToPath(import.meta.url));
/** Order books recorded from nonlogs.io on 2026-10-07 (public, no key). */
function fixture(pair: string): OrderBook {
  return JSON.parse(readFileSync(join(here, 'fixtures/nonlogs', `ob-${pair}.json`), 'utf8')) as OrderBook;
}
const recorded = new Map(['WOW-BTC', 'WOW-XMR', 'GRIN-BTC', 'LTC-BTC', 'XMR-BTC'].map((p) => [p, fixture(p)]));

const book: OrderBook = {
  pair: 'AAA-BBB',
  bids: [
    ['0.09', '10'],
    ['0.08', '10'],
  ],
  asks: [
    ['0.2', '10'],
    ['0.1', '10'],
  ],
};

test('decimals round-trip exactly', () => {
  assert.equal(fmt(dec('0.00000011')), '0.00000011');
  assert.equal(fmt(dec('39017.10123385098')), '39017.10123385098');
  assert.throws(() => dec('1e5'));
  assert.throws(() => dec('-1'));
});

test('buying lifts the asks best first, whatever order they arrive in', () => {
  const leg = legBetween('BBB', 'AAA', new Set(['AAA-BBB']))!;
  assert.equal(leg.side, 'buy');
  // 2 BBB: 10 AAA at 0.1 costs 1, then 1 BBB buys 5 more at 0.2.
  const r = walkLeg(book, leg, dec('2'));
  assert.equal(fmt(r.grossOut), '15');
  assert.equal(r.exhausted, false);
  assert.equal(fmt(r.vwap, 6), '0.133333');
  // Mid (0.09 + 0.1) / 2 = 0.095; buying 0.1333 is 40.35 percent worse.
  assert.ok(r.impact !== null && Math.abs(r.impact - 0.403508) < 1e-5, String(r.impact));
  assert.equal(fmt(r.depthIn), '3', 'the asks hold 3 BBB of value');
});

test('selling hits the bids best first', () => {
  const leg = legBetween('AAA', 'BBB', new Set(['AAA-BBB']))!;
  assert.equal(leg.side, 'sell');
  const r = walkLeg(book, leg, dec('15'));
  // 10 at 0.09 + 5 at 0.08
  assert.equal(fmt(r.grossOut), '1.3');
  assert.equal(fmt(r.depthIn), '20');
});

test('an order larger than the book is reported as exceeding depth, never extrapolated', () => {
  const leg = legBetween('AAA', 'BBB', new Set(['AAA-BBB']))!;
  const r = walkLeg(book, leg, dec('25'));
  assert.equal(r.exhausted, true);
  assert.equal(fmt(r.filledIn), '20', 'only what the bids hold');
  assert.equal(fmt(r.grossOut), '1.7');
});

test('the taker fee comes off each leg', () => {
  const leg = legBetween('AAA', 'BBB', new Set(['AAA-BBB']))!;
  const r = walkLeg(book, leg, dec('10'), dec('0.0015'));
  assert.equal(fmt(r.grossOut), '0.9');
  assert.equal(fmt(r.netOut), '0.89865');
});

test('recorded WOW-BTC: 0.001 BTC buys through two ask levels', () => {
  const legs = planRoute('BTC', 'WOW', new Set(recorded.keys()))!;
  assert.equal(legs.length, 1);
  assert.equal(legs[0]!.pair, 'WOW-BTC');
  const r = walkRoute(legs, recorded, dec('0.001'));
  // 2937 WOW at 0.00000011 costs 0.00032307 BTC; the remaining 0.00067693
  // buys 5641.083333... at 0.00000012.
  assert.equal(fmt(r.grossOut, 6), '8578.083333');
  assert.equal(r.exceedsDepth, false);
  assert.ok(r.impact !== null && r.impact > 0 && r.impact < 0.2, String(r.impact));
});

test('fees: taker per leg, the convenience fee and the network fee, in that order', () => {
  const legs = planRoute('BTC', 'WOW', new Set(recorded.keys()))!;
  const r = walkRoute(legs, recorded, dec('0.001'), {
    takerFee: dec('0.0015'),
    convenienceFee: dec('0.008'),
    networkFeeOut: dec('2'),
  });
  // 8578.083333... less 0.15 percent, less 0.8 percent, less 2 WOW.
  const expected = 8578.083333333 * (1 - 0.0015) * (1 - 0.008) - 2;
  assert.ok(Math.abs(Number(fmt(r.expectedOut, 6)) - expected) < 0.001, `${fmt(r.expectedOut)} vs ${expected}`);
  assert.ok(r.expectedOut < r.grossOut);
});

test('multi-leg: GRIN to WOW routes through BTC and walks both books', () => {
  const legs = planRoute('GRIN', 'WOW', new Set(recorded.keys()))!;
  assert.deepEqual(
    legs.map((l) => `${l.pair}:${l.side}`),
    ['GRIN-BTC:sell', 'WOW-BTC:buy'],
  );
  const r = walkRoute(legs, recorded, dec('1000'));
  // 1000 GRIN into the GRIN-BTC bids (best 0.00000017 x 2713.1) yields
  // 0.00017 BTC, which lifts 0.00017 / 0.00000011 = 1545.45 WOW.
  assert.equal(fmt(r.legs[0]!.grossOut, 8), '0.00017');
  assert.equal(fmt(r.grossOut, 2), '1545.45');
  assert.equal(r.exceedsDepth, false);
});

test('a reported route of pair symbols becomes the same legs', () => {
  const legs = legsFromPairs('GRIN', ['GRIN-BTC', 'WOW-BTC'])!;
  assert.deepEqual(legs.map((l) => `${l.from}>${l.to}`), ['GRIN>BTC', 'BTC>WOW']);
  assert.equal(legsFromPairs('GRIN', ['WOW-XMR']), null, 'a route that does not start from the input is refused');
});

test('an empty book is exceeds-depth with nothing filled, not a zero price', () => {
  const legs = planRoute('LTC', 'BTC', new Set(recorded.keys()))!;
  const r = walkRoute(legs, recorded, dec('0.5'));
  assert.equal(r.exceedsDepth, true);
  assert.equal(r.expectedOut, 0n);
  assert.equal(depthWarning(r), 'exceeds_depth');
  assert.equal(r.maxInput, 0n);
});

test('max fillable input fills completely, and a little more does not', () => {
  const legs = planRoute('GRIN', 'WOW', new Set(recorded.keys()))!;
  const max = maxFillableInput(legs, recorded);
  assert.ok(max > 0n);
  assert.equal(walkRoute(legs, recorded, max).exceedsDepth, false);
  assert.equal(walkRoute(legs, recorded, max + dec('1')).exceedsDepth, true);
});

test('warnings follow the impact thresholds', () => {
  const legs = planRoute('BTC', 'WOW', new Set(recorded.keys()))!;
  assert.equal(depthWarning(null), 'no_market');
  const small = walkRoute(legs, recorded, dec('0.0001'));
  assert.equal(depthWarning(small), small.impact! >= 0.03 ? (small.impact! >= 0.1 ? 'strong' : 'notice') : 'none');
  const big = walkRoute(legs, recorded, dec('1'));
  assert.ok(big.impact !== null && big.impact >= 0.1, `impact ${big.impact}`);
  assert.equal(depthWarning(big), 'strong');
  const huge = walkRoute(legs, recorded, dec('5'));
  assert.equal(depthWarning(huge), 'exceeds_depth');
});

test('no route when no market connects the pair', () => {
  assert.equal(planRoute('GRIN', 'DOGE', new Set(recorded.keys())), null);
});

test('estimates differing by more than 2 percent are material', () => {
  assert.equal(materiallyDifferent(dec('100'), dec('99')), false);
  assert.equal(materiallyDifferent(dec('100'), dec('97')), true);
  assert.equal(materiallyDifferent(0n, 0n), false);
});
