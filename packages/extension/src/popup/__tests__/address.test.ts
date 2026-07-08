/**
 * Popup address-validation dispatch (extracted from index.tsx). The codecs
 * themselves are covered in @smirk/core address.test.ts; here we cover the
 * popup-specific error shaping — empty input, unknown asset, and the CryptoNote
 * base58 char-position hint that helps users spot copy-paste mangling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAddress, validateSendRecipient, recipientNpubToHex } from '../address';

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

test('validateSendRecipient: Grin also accepts an npub / raw x-only hex', () => {
  const hex = 'ab'.repeat(32); // 64-char x-only pubkey
  assert.equal(validateSendRecipient('grin', hex), null); // valid Nostr recipient
  assert.equal(validateSendRecipient('grin', 'npub1notarealbech32'), 'Not a valid npub');
  // A non-npub grin string still goes through the normal address validator.
  assert.match(validateSendRecipient('grin', 'not-an-address') ?? '', /Not a valid GRIN/);
  // Non-grin assets are unaffected — an npub is not a valid BTC address.
  assert.match(validateSendRecipient('btc', hex) ?? '', /Not a valid BTC/);
});

test('recipientNpubToHex: hex → itself, non-npub/hex → null', () => {
  const hex = 'cd'.repeat(32);
  assert.equal(recipientNpubToHex(hex), hex);
  assert.equal(recipientNpubToHex('grin1someaddress'), null); // a slatepack address, not nostr
  assert.equal(recipientNpubToHex('npub1bad'), null); // malformed npub
});
