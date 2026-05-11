/**
 * Address-validator regression tests.
 *
 * Covers the validators added in 2026-05-10 audit fix M3 — XMR, WOW,
 * Grin slatepack — plus the existing BTC/LTC ones for completeness.
 *
 * Test vectors:
 *  - The XMR / WOW vectors are obtained by encoding random 32-byte
 *    keys via this codebase's own `xmrAddress` / `wowAddress`
 *    helpers (round-trip), giving us a `valid` set without depending
 *    on external services.
 *  - Negative vectors target each likely failure mode: typo (single
 *    char swap → checksum fails), wrong network (XMR address checked
 *    against WOW validator, etc.), wrong length, alphabet violations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidBtcAddress,
  isValidGrinSlatepackAddress,
  isValidLtcAddress,
  isValidWowAddress,
  isValidXmrAddress,
  xmrAddress,
  wowAddress,
  grinSlatpackAddress,
} from '../address';

function fixedBytes(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i) & 0xff;
  return out;
}

const SPEND = fixedBytes(7);
const VIEW = fixedBytes(13);

// ============================================================================
// XMR
// ============================================================================

test('isValidXmrAddress: round-trips a self-encoded address', () => {
  const addr = xmrAddress(SPEND, VIEW);
  assert.equal(isValidXmrAddress(addr), true, addr);
});

test('isValidXmrAddress: rejects a single-char-swapped address (checksum)', () => {
  const addr = xmrAddress(SPEND, VIEW);
  // Swap the 50th character to something different in the alphabet.
  const ch = addr[50] === 'A' ? 'B' : 'A';
  const tampered = addr.slice(0, 50) + ch + addr.slice(51);
  assert.equal(isValidXmrAddress(tampered), false);
});

test('isValidXmrAddress: rejects a WOW address (wrong prefix)', () => {
  const wow = wowAddress(SPEND, VIEW);
  assert.equal(isValidXmrAddress(wow), false);
});

test('isValidXmrAddress: rejects empty / short / alphabet-violating strings', () => {
  assert.equal(isValidXmrAddress(''), false);
  assert.equal(isValidXmrAddress('not-an-address'), false);
  // 'l' (lowercase L), '0', 'O', 'I' are not in the Monero base58 alphabet
  assert.equal(isValidXmrAddress('lOIl0'.repeat(20)), false);
});

// ============================================================================
// WOW
// ============================================================================

test('isValidWowAddress: round-trips a self-encoded address', () => {
  const addr = wowAddress(SPEND, VIEW);
  assert.equal(isValidWowAddress(addr), true, addr);
});

test('isValidWowAddress: rejects an XMR address (wrong prefix)', () => {
  const xmr = xmrAddress(SPEND, VIEW);
  assert.equal(isValidWowAddress(xmr), false);
});

test('isValidWowAddress: rejects malformed input', () => {
  assert.equal(isValidWowAddress(''), false);
  assert.equal(isValidWowAddress('Wo' + '?'.repeat(95)), false);
});

// ============================================================================
// Grin slatepack
// ============================================================================

test('isValidGrinSlatepackAddress: round-trips a self-encoded address', () => {
  const addr = grinSlatpackAddress(fixedBytes(3));
  assert.equal(isValidGrinSlatepackAddress(addr), true, addr);
});

test('isValidGrinSlatepackAddress: rejects bech32 with non-grin hrp', () => {
  // A valid bech32 with a different hrp must not pass — even if the
  // payload length matches.
  assert.equal(
    isValidGrinSlatepackAddress(
      'bc1qzxy3rst5dh4uw0eq37j2j8j6lggw9j6dz4mrt8',
    ),
    false,
  );
});

test('isValidGrinSlatepackAddress: rejects malformed strings', () => {
  assert.equal(isValidGrinSlatepackAddress(''), false);
  assert.equal(isValidGrinSlatepackAddress('grin1'), false); // no payload
  assert.equal(isValidGrinSlatepackAddress('grin1!!!'), false);
  assert.equal(isValidGrinSlatepackAddress('grinX1aaaaaa'), false); // wrong hrp
});

// ============================================================================
// Cross-asset: every validator rejects every other asset's valid address
// ============================================================================

test('cross-asset rejection — each validator only accepts its own family', () => {
  const xmr = xmrAddress(SPEND, VIEW);
  const wow = wowAddress(SPEND, VIEW);
  const grin = grinSlatpackAddress(fixedBytes(5));

  // BTC bech32 (synthesized — must round-trip via @scure/base if needed
  // to test BTC, but for this matrix it's enough to confirm the
  // Cryptonote / Grin validators reject obvious BTC strings).
  const btcLike = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

  assert.equal(isValidXmrAddress(wow), false);
  assert.equal(isValidXmrAddress(grin), false);
  assert.equal(isValidXmrAddress(btcLike), false);

  assert.equal(isValidWowAddress(xmr), false);
  assert.equal(isValidWowAddress(grin), false);
  assert.equal(isValidWowAddress(btcLike), false);

  assert.equal(isValidGrinSlatepackAddress(xmr), false);
  assert.equal(isValidGrinSlatepackAddress(wow), false);
  assert.equal(isValidGrinSlatepackAddress(btcLike), false);

  assert.equal(isValidBtcAddress(xmr), false);
  assert.equal(isValidBtcAddress(wow), false);
  assert.equal(isValidBtcAddress(grin), false);

  assert.equal(isValidLtcAddress(xmr), false);
  assert.equal(isValidLtcAddress(wow), false);
  assert.equal(isValidLtcAddress(grin), false);
});
