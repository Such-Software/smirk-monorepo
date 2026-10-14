// The THORChain deposit oracle accepts any active vault of the chain, and
// nothing else. No network.
//
//   node --test packages/e2e/fixtures/E-swaps-thorvaults.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeVaultAddresses } from './E-swaps-thorvaults.mjs';

const inbound = [
  { chain: 'BTC', address: 'bc1-advertised', halted: false },
  { chain: 'LTC', address: 'ltc1-advertised', halted: false },
];
const asgard = [
  { status: 'ActiveVault', addresses: [{ chain: 'BTC', address: 'bc1-advertised' }, { chain: 'LTC', address: 'ltc1-advertised' }] },
  { status: 'ActiveVault', addresses: [{ chain: 'BTC', address: 'bc1-quoted' }, { chain: 'LTC', address: 'ltc1-quoted' }] },
  { status: 'RetiringVault', addresses: [{ chain: 'BTC', address: 'bc1-retiring' }] },
];

test('a quote may name an active vault other than the advertised one', () => {
  const btc = activeVaultAddresses('BTC', inbound, asgard);
  assert.ok(btc.includes('bc1-quoted'), 'the 2026-10-14 case: the quoted vault was active but not advertised');
  assert.ok(btc.includes('bc1-advertised'));
});

test('retiring vaults and other chains are not accepted', () => {
  const btc = activeVaultAddresses('BTC', inbound, asgard);
  assert.ok(!btc.includes('bc1-retiring'));
  assert.ok(!btc.some((a) => a.startsWith('ltc1')));
});

test('a halted chain, a missing chain or no active vault refuses with the cause', () => {
  assert.throws(() => activeVaultAddresses('BTC', [{ chain: 'BTC', halted: true }], asgard), /halted BTC/);
  assert.throws(() => activeVaultAddresses('DOGE', inbound, asgard), /no DOGE inbound/);
  assert.throws(() => activeVaultAddresses('BTC', inbound, [asgard[2]]), /no active BTC vault/);
});
