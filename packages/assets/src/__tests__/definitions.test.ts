/**
 * Per-asset definition sanity tests.
 *
 * Catch regressions on values where "right answer" matters:
 * decimals (off-by-one is a wallet-emptying bug), confirmations
 * (mismatch with backend = stuck claims), ring sizes (wrong value
 * = invalid tx).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { btc, ltc, xmr, wow, grin } from '../index';

// ----- BTC ---------------------------------------------------------------

test('btc decimals = 8', () => {
  assert.equal(btc.decimals, 8);
});

test('btc family is utxo with both segwit and taproot', () => {
  assert.equal(btc.family.family, 'utxo');
  if (btc.family.family !== 'utxo') return; // type narrow
  assert.equal(btc.family.features.segwit, true);
  assert.equal(btc.family.features.taproot, true);
  assert.equal(btc.family.features.mweb, false);
});

test('btc has both mainnet and testnet', () => {
  assert.notEqual(btc.networks.mainnet, undefined);
  assert.notEqual(btc.networks.testnet, undefined);
});

test('btc derivation paths use BIP84 (m/84\')', () => {
  assert.match(btc.networks.mainnet!.defaultDerivationPath, /^m\/84'/);
  assert.match(btc.networks.testnet!.defaultDerivationPath, /^m\/84'/);
});

// ----- LTC ---------------------------------------------------------------

test('ltc decimals = 8', () => {
  assert.equal(ltc.decimals, 8);
});

test('ltc bip44 coin type = 2 (SLIP-44)', () => {
  assert.equal(ltc.networks.mainnet!.bip44CoinType, 2);
});

test('ltc MWEB flag is currently false (roadmap)', () => {
  assert.equal(ltc.family.family, 'utxo');
  if (ltc.family.family !== 'utxo') return;
  assert.equal(ltc.family.features.mweb, false);
});

// ----- XMR ---------------------------------------------------------------

test('xmr decimals = 12 (1 XMR = 1e12 piconero)', () => {
  assert.equal(xmr.decimals, 12);
});

test('xmr ring size = 16 and rctType = 6 (ClsagBulletproofPlus)', () => {
  assert.equal(xmr.family.family, 'cryptonote');
  if (xmr.family.family !== 'cryptonote') return;
  assert.equal(xmr.family.ringSize, 16);
  assert.equal(xmr.family.rctType, 6);
});

test('xmr integratedAddresses removed at protocol level', () => {
  assert.equal(xmr.family.family, 'cryptonote');
  if (xmr.family.family !== 'cryptonote') return;
  assert.equal(xmr.family.features.integratedAddresses, false);
});

test('xmr confirmations = 10 (matches backend)', () => {
  assert.equal(xmr.confirmationsRequired, 10);
});

// ----- WOW ---------------------------------------------------------------

test('wow decimals = 11 (NOT 12 — differs from XMR; common bug)', () => {
  assert.equal(wow.decimals, 11);
});

test('wow ring size = 22 and rctType = 8 (WowneroClsagBulletproofPlus)', () => {
  assert.equal(wow.family.family, 'cryptonote');
  if (wow.family.family !== 'cryptonote') return;
  assert.equal(wow.family.ringSize, 22);
  assert.equal(wow.family.rctType, 8);
});

test('wow integratedAddresses still supported', () => {
  assert.equal(wow.family.family, 'cryptonote');
  if (wow.family.family !== 'cryptonote') return;
  assert.equal(wow.family.features.integratedAddresses, true);
});

test('wow confirmations = 4', () => {
  assert.equal(wow.confirmationsRequired, 4);
});

test('wow has no aggregator swap routes (native-only path)', () => {
  assert.deepEqual(wow.swapRoutes, []);
});

// ----- Grin --------------------------------------------------------------

test('grin decimals = 9', () => {
  assert.equal(grin.decimals, 9);
});

test('grin addressKind is interactive (slatepacks, not addresses)', () => {
  assert.equal(grin.addressKind, 'interactive');
});

test('grin family is mimblewimble with payment proofs and NRD kernels', () => {
  assert.equal(grin.family.family, 'mimblewimble');
  if (grin.family.family !== 'mimblewimble') return;
  assert.equal(grin.family.features.paymentProofs, true);
  assert.equal(grin.family.features.nrdKernels, true);
  assert.equal(grin.family.slateVersion, 4);
});

test('grin confirmations = 10', () => {
  assert.equal(grin.confirmationsRequired, 10);
});

test('grin has no aggregator swap routes (v0.4+ native target)', () => {
  assert.deepEqual(grin.swapRoutes, []);
});

// ----- Cross-asset invariants -------------------------------------------

test('every built-in asset has socialTipping = true', () => {
  for (const a of [btc, ltc, xmr, wow, grin]) {
    assert.equal(a.socialTipping, true, `${a.id} should support social tipping`);
  }
});

test('every built-in asset id is lowercase', () => {
  for (const a of [btc, ltc, xmr, wow, grin]) {
    assert.equal(a.id, a.id.toLowerCase());
  }
});

test('every built-in asset ticker is uppercase', () => {
  for (const a of [btc, ltc, xmr, wow, grin]) {
    assert.equal(a.ticker, a.ticker.toUpperCase());
  }
});

test('every built-in asset has its defaultNetwork registered in its networks map', () => {
  for (const a of [btc, ltc, xmr, wow, grin]) {
    assert.notEqual(
      a.networks[a.defaultNetwork],
      undefined,
      `${a.id} defaultNetwork "${a.defaultNetwork}" must exist in networks`,
    );
  }
});
