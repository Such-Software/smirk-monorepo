/**
 * Popup address-validation dispatch (extracted from index.tsx). The codecs
 * themselves are covered in @smirk/core address.test.ts; here we cover the
 * popup-specific error shaping — empty input, unknown asset, and the CryptoNote
 * base58 char-position hint that helps users spot copy-paste mangling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAddress } from '../address';

test('empty input → "Address is empty"', () => {
  assert.equal(validateAddress('btc', '   '), 'Address is empty');
});

test('invalid BTC → generic reason with ticker', () => {
  const msg = validateAddress('btc', 'definitely-not-an-address');
  assert.match(msg ?? '', /Not a valid BTC address/);
});

test('CryptoNote junk → points at the first out-of-alphabet char + position', () => {
  // `0` (zero) is not in the Monero base58 alphabet.
  const msg = validateAddress('xmr', '4AdUndXHHZ0aQ');
  assert.match(msg ?? '', /char '0' at position 11 isn't in base58/);
});

test('unknown asset throws (validateAddress is only called with the 5 known assets)', () => {
  assert.throws(() => validateAddress('doge', 'x'));
});
