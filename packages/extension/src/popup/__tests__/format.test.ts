/**
 * Pure popup formatters (extracted from index.tsx). These were untested inside the
 * 7k-line entry point; extraction makes them coverable. Amount round-trips are the
 * load-bearing ones — a parse/format mismatch is money shown wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatUsd, parseAmount, atomicToText, feedTimeAgo, bytesToHex, randomToken } from '../format';

test('formatUsd: currency format + em dash for non-finite', () => {
  assert.equal(formatUsd(1234.5), '$1,234.50');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(Number.NaN), '—');
  assert.equal(formatUsd(Number.POSITIVE_INFINITY), '—');
});

test('parseAmount: decimals honored, BigInt-exact, junk → null', () => {
  // btc = 8 decimals
  assert.equal(parseAmount('btc', '1'), 100_000_000n);
  assert.equal(parseAmount('btc', '0.00000001'), 1n);
  assert.equal(parseAmount('btc', '21.5'), 2_150_000_000n);
  assert.equal(parseAmount('btc', ''), null);
  assert.equal(parseAmount('btc', 'abc'), null);
  assert.equal(parseAmount('btc', '0.000000001'), null); // 9 fractional > 8 decimals
  assert.equal(parseAmount('btc', '1'.repeat(33)), null); // over the length cap
});

test('atomicToText: inverse of parseAmount, trailing zeros trimmed', () => {
  assert.equal(atomicToText('100000000', 'btc'), '1');
  assert.equal(atomicToText('2150000000', 'btc'), '21.5');
  assert.equal(atomicToText('1', 'btc'), '0.00000001');
  // round-trip
  for (const s of ['1', '21.5', '0.00000001', '999.12345678']) {
    assert.equal(atomicToText(parseAmount('btc', s)!.toString(), 'btc'), s);
  }
});

test('feedTimeAgo: compact buckets', () => {
  const now = 1_000_000_000_000; // ms
  const nowSec = Math.floor(now / 1000);
  assert.equal(feedTimeAgo(nowSec, now), '0s');
  assert.equal(feedTimeAgo(nowSec - 45, now), '45s');
  assert.equal(feedTimeAgo(nowSec - 120, now), '2m');
  assert.equal(feedTimeAgo(nowSec - 7200, now), '2h');
  assert.equal(feedTimeAgo(nowSec - 172800, now), '2d');
  assert.equal(feedTimeAgo(nowSec + 100, now), '0s'); // clamps negatives
});

test('bytesToHex: lowercase, zero-padded', () => {
  assert.equal(bytesToHex(new Uint8Array([0, 15, 255, 16])), '000fff10');
  assert.equal(bytesToHex(new Uint8Array([])), '');
});

test('randomToken: URL-safe, no padding, length scales', () => {
  const t = randomToken(32);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.ok(!t.includes('='));
  assert.notEqual(randomToken(16), randomToken(16)); // random
});
