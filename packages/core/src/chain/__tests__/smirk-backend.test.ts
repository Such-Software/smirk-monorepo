/**
 * The default chain providers must be pure delegators: each method forwards to
 * the exact api.* method (preserving retry policy + response envelope), and the
 * two synthesised reads (getHeight, estimateFee) wrap existing data. These tests
 * lock that in so a reroute (later PRs) is provably behaviour-identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SmirkGrinProvider, SmirkLwsProvider, SmirkUtxoProvider } from '../smirk-backend';
import { createChainProviders } from '../registry';
import type { SmirkApi } from '../../api';

interface Call {
  method: string;
  args: unknown[];
}

function mockApi(): { api: SmirkApi; calls: Call[] } {
  const calls: Call[] = [];
  const ok = (data: unknown) => ({ data, status: 200 });
  const stub =
    (method: string, ret: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(ret);
    };
  const api = {
    // utxo
    getUtxoBalance: stub('getUtxoBalance', ok({ asset: 'btc', address: 'a', confirmed: 1, unconfirmed: 0, total: 1 })),
    getUtxos: stub('getUtxos', ok({ asset: 'btc', address: 'a', utxos: [] })),
    broadcastTx: stub('broadcastTx', ok({ asset: 'btc', txid: 'tx1' })),
    getHistory: stub('getHistory', ok({ asset: 'btc', address: 'a', transactions: [] })),
    estimateFee: stub('estimateFee', ok({ asset: 'btc', fast: 3, normal: 2, slow: 1 })),
    getBlockchainHeights: stub('getBlockchainHeights', ok({ btc: 100, ltc: 200, xmr: null, wow: null, grin: 50 })),
    // lws
    getLwsBalance: stub('getLwsBalance', ok({ total_received: 0, locked_balance: 0, pending_balance: 0, transaction_count: 0, blockchain_height: 0, start_height: 0, scanned_height: 0, spent_outputs: [] })),
    getUnspentOuts: stub('getUnspentOuts', ok({ outputs: [], per_byte_fee: 1, fee_mask: 1 })),
    submitLwsTx: stub('submitLwsTx', ok({ success: true, status: 'ok' })),
    getLwsHistory: stub('getLwsHistory', ok({ asset: 'xmr', transactions: [], scanned_height: 0, blockchain_height: 0 })),
    getRandomOuts: stub('getRandomOuts', ok({ outputs: [] })),
    registerLws: stub('registerLws', ok({ success: true, message: 'ok' })),
    deactivateLws: stub('deactivateLws', ok({ success: true, message: 'ok' })),
    // grin
    getGrinUserBalance: stub('getGrinUserBalance', ok({ confirmed: 0, locked: 0, pending: 0, total: 0 })),
    getGrinOutputs: stub('getGrinOutputs', ok({ outputs: [], next_child_index: 0 })),
    getGrinUserHistory: stub('getGrinUserHistory', ok({ transactions: [] })),
    broadcastGrinTransaction: stub('broadcastGrinTransaction', ok({ success: true })),
    scanGrinUnspentOutputs: stub('scanGrinUnspentOutputs', ok({ highest_index: 0, last_retrieved_index: 0, outputs: [] })),
    recordGrinOutput: stub('recordGrinOutput', ok({ id: 'o1' })),
    lockGrinOutputs: stub('lockGrinOutputs', ok(undefined)),
    unlockGrinOutputs: stub('unlockGrinOutputs', ok(undefined)),
    spendGrinOutputs: stub('spendGrinOutputs', ok(undefined)),
  } as unknown as SmirkApi;
  return { api, calls };
}

test('utxo provider delegates to the exact api methods and passes results through', async () => {
  const { api, calls } = mockApi();
  const p = new SmirkUtxoProvider('btc', api);
  const bal = await p.getBalance('addr1');
  await p.listOutputs('addr1');
  await p.broadcast('deadbeef');
  await p.getHistory('addr1');
  assert.deepEqual(
    calls.map((c) => c.method),
    ['getUtxoBalance', 'getUtxos', 'broadcastTx', 'getHistory'],
  );
  assert.deepEqual(calls[0].args, ['btc', 'addr1']); // asset threaded through
  assert.deepEqual(calls[2].args, ['btc', 'deadbeef']);
  assert.equal(bal.data?.total, 1); // pure passthrough of the envelope
});

test('utxo estimateFee maps the endpoint to the rate-estimate model', async () => {
  const { api } = mockApi();
  const r = await new SmirkUtxoProvider('ltc', api).estimateFee();
  assert.deepEqual(r.data, { model: 'rate-estimate', fast: 3, normal: 2, slow: 1 });
});

test('getHeight selects this chain from the shared heights map', async () => {
  const { api } = mockApi();
  assert.equal((await new SmirkUtxoProvider('btc', api).getHeight()).data?.height, 100);
  assert.equal((await new SmirkGrinProvider(api).getHeight()).data?.height, 50);
  assert.equal((await new SmirkLwsProvider('xmr', api).getHeight()).data?.height, null);
});

test('lws provider delegates with asset + view key, declares param-derived fee', async () => {
  const { api, calls } = mockApi();
  const p = new SmirkLwsProvider('xmr', api);
  await p.getBalance('addr', 'vk');
  await p.registerAccount('user1', 'addr', 'vk', 12345);
  assert.deepEqual(calls[0], { method: 'getLwsBalance', args: ['xmr', 'addr', 'vk'] });
  assert.deepEqual(calls[1], { method: 'registerLws', args: ['user1', 'xmr', 'addr', 'vk', 12345] });
  assert.deepEqual((await p.estimateFee()).data, { model: 'param-derived' });
});

test('grin provider delegates lifecycle + recovery, declares formula fee', async () => {
  const { api, calls } = mockApi();
  const p = new SmirkGrinProvider(api);
  await p.getBalance('u');
  await p.broadcast({ userId: 'u', slateId: 's', tx: {} });
  await p.scanUnspent({ startIndex: 0 });
  await p.lockOutputs({ userId: 'u', outputIds: ['a'], txSlateId: 's' });
  assert.deepEqual(
    calls.map((c) => c.method),
    ['getGrinUserBalance', 'broadcastGrinTransaction', 'scanGrinUnspentOutputs', 'lockGrinOutputs'],
  );
  assert.deepEqual((await p.estimateFee()).data, { model: 'formula' });
});

test('capabilities reflect each chain model', () => {
  const { api } = mockApi();
  assert.equal(new SmirkUtxoProvider('btc', api).capabilities.model, 'utxo');
  assert.equal(new SmirkLwsProvider('wow', api).capabilities.requiresViewKey, true);
  assert.equal(new SmirkGrinProvider(api).capabilities.hasRecoveryScan, true);
});

test('registry returns per-chain providers and supports server-options swaps', () => {
  const { api } = mockApi();
  const reg = createChainProviders(api);
  assert.equal(reg.utxo('btc').asset, 'btc');
  assert.equal(reg.lws('xmr').asset, 'xmr');
  assert.equal(reg.grin().asset, 'grin');
  const custom = new SmirkUtxoProvider('btc', api);
  reg.setUtxo('btc', custom);
  assert.equal(reg.utxo('btc'), custom);
});
