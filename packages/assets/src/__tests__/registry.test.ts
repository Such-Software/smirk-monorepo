/**
 * Registry behavior + structural validation tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AssetRegistry,
  AssetRegistryError,
  registry,
  ASSET_IDS,
  btc,
  ltc,
  xmr,
  wow,
  grin,
} from '../index';
import type { AssetDefinition } from '../types';

// ----- Bootstrap ----------------------------------------------------------

test('built-in registry has exactly the 5 expected assets', () => {
  assert.equal(registry.size(), 5);
  assert.deepEqual(registry.ids(), ['btc', 'ltc', 'xmr', 'wow', 'grin']);
});

test('all 5 built-in ids retrievable via mustGet', () => {
  for (const id of Object.values(ASSET_IDS)) {
    const def = registry.mustGet(id);
    assert.equal(def.id, id);
  }
});

test('mustGet throws for unknown id', () => {
  assert.throws(() => registry.mustGet('eth'), AssetRegistryError);
});

test('get returns undefined for unknown id', () => {
  assert.equal(registry.get('eth'), undefined);
});

// ----- Filtering ----------------------------------------------------------

test('list({ family: "utxo" }) returns btc + ltc', () => {
  const utxo = registry.list({ family: 'utxo' });
  assert.deepEqual(
    utxo.map((a) => a.id),
    ['btc', 'ltc'],
  );
});

test('list({ family: "cryptonote" }) returns xmr + wow', () => {
  const cn = registry.list({ family: 'cryptonote' });
  assert.deepEqual(
    cn.map((a) => a.id),
    ['xmr', 'wow'],
  );
});

test('list({ family: "mimblewimble" }) returns grin only', () => {
  const mw = registry.list({ family: 'mimblewimble' });
  assert.deepEqual(
    mw.map((a) => a.id),
    ['grin'],
  );
});

test('list({ swapRoute: "thorchain" }) returns btc, ltc, xmr (no wow, no grin)', () => {
  const thor = registry.list({ swapRoute: 'thorchain' });
  assert.deepEqual(
    thor.map((a) => a.id).sort(),
    ['btc', 'ltc', 'xmr'].sort(),
  );
});

test('list({ socialTippingOnly: true }) returns all 5 (every asset supports tipping)', () => {
  const tipping = registry.list({ socialTippingOnly: true });
  assert.equal(tipping.length, 5);
});

test('list({ network: "testnet" }) returns btc + ltc only', () => {
  const tn = registry.list({ network: 'testnet' });
  assert.deepEqual(
    tn.map((a) => a.id).sort(),
    ['btc', 'ltc'].sort(),
  );
});

test('list({ hasUtxoFeature: "mweb" }) returns nothing yet (LTC MWEB unimplemented)', () => {
  const mweb = registry.list({ hasUtxoFeature: 'mweb' });
  assert.deepEqual(mweb, []);
});

test('list({ hasUtxoFeature: "taproot" }) returns btc only', () => {
  const tr = registry.list({ hasUtxoFeature: 'taproot' });
  assert.deepEqual(
    tr.map((a) => a.id),
    ['btc'],
  );
});

// ----- Registration semantics --------------------------------------------

test('register() is rejected on duplicate id', () => {
  const r = new AssetRegistry();
  r.register(btc);
  assert.throws(() => r.register(btc), AssetRegistryError);
});

test('isolated registries do not share state', () => {
  const r1 = new AssetRegistry();
  const r2 = new AssetRegistry();
  r1.register(btc);
  assert.equal(r1.size(), 1);
  assert.equal(r2.size(), 0);
});

test('register() rejects mixed-case id', () => {
  const r = new AssetRegistry();
  const bad: AssetDefinition = { ...btc, id: 'BTC' };
  assert.throws(() => r.register(bad), AssetRegistryError);
});

test('register() rejects negative decimals', () => {
  const r = new AssetRegistry();
  const bad: AssetDefinition = { ...btc, id: 'badbtc', decimals: -1 };
  assert.throws(() => r.register(bad), AssetRegistryError);
});

test('register() rejects defaultNetwork that is not in networks map', () => {
  const r = new AssetRegistry();
  const bad: AssetDefinition = { ...btc, id: 'badbtc', defaultNetwork: 'regtest' };
  assert.throws(() => r.register(bad), AssetRegistryError);
});

test('register() rejects cryptonote with ringSize < 2', () => {
  const r = new AssetRegistry();
  const bad: AssetDefinition = {
    ...xmr,
    id: 'badxmr',
    family: { ...xmr.family, ringSize: 1 } as never,
  };
  assert.throws(() => r.register(bad), AssetRegistryError);
});

test('_clearForTests clears the registry', () => {
  const r = new AssetRegistry();
  r.register(btc);
  r._clearForTests();
  assert.equal(r.size(), 0);
});
