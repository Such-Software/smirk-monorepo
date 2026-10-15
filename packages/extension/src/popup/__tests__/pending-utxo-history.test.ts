/**
 * The balance refresh reads BTC/LTC tx history only for coins with a spend in
 * flight, over the same addresses as the balance, and reports a failed read as
 * unknown rather than as "nothing listed" (which would release the spend).
 * With that history, an hour-old spend still in the mempool stays deducted.
 */
import './_chrome-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAfterBalanceRefresh, utxoAvailableDeduction, type PendingOutgoingTx } from '@smirk/core';
import { readPendingUtxoHistory } from '../pending-utxo-history';

const T0 = 1_760_000_000_000;
const ADDRESSES = { btc: 'bc1qprimary', ltc: 'ltc1qprimary' };

const btcSpend: PendingOutgoingTx = {
  asset: 'btc',
  txHash: 'aa'.repeat(32),
  amount: '3000',
  fee: '154',
  recipient: 'bc1qtip',
  submittedAt: T0,
  inputs: [`${'11'.repeat(32)}:0`],
};

type History = { txid: string; height: number }[];

function fakeProviders(byAsset: Partial<Record<'btc' | 'ltc', History | Error | 'error'>>) {
  const calls: string[] = [];
  const reply = (asset: 'btc' | 'ltc') => {
    const h = byAsset[asset];
    if (h instanceof Error) throw h;
    if (h === 'error' || h === undefined) return { error: 'Network error', status: 502 };
    return { data: { asset, address: '', transactions: h }, status: 200 };
  };
  const providers = {
    utxo: (asset: 'btc' | 'ltc') => ({
      getHistory: async (address: string) => {
        calls.push(`${asset}:single:${address}`);
        return reply(asset);
      },
      getHistoryMulti: async (addresses: string[]) => {
        calls.push(`${asset}:multi:${addresses.join(',')}`);
        return reply(asset);
      },
    }),
  };
  return { providers: providers as unknown as Parameters<typeof readPendingUtxoHistory>[0], calls };
}

test('nothing in flight: no history is read', async () => {
  const { providers, calls } = fakeProviders({});
  const out = await readPendingUtxoHistory(providers, ADDRESSES, [], undefined);
  assert.deepEqual(out, {});
  assert.deepEqual(calls, []);
});

test('reads only the coin with a spend in flight, over the primary address by default', async () => {
  const { providers, calls } = fakeProviders({ btc: [{ txid: btcSpend.txHash, height: 0 }] });
  const out = await readPendingUtxoHistory(providers, ADDRESSES, [btcSpend], undefined);
  assert.deepEqual(calls, ['btc:single:bc1qprimary']);
  assert.ok(out.btc && out.btc.length === 1);
  assert.equal('ltc' in out, false);
});

test('reads the fresh-address scan set when the host built one', async () => {
  const { providers, calls } = fakeProviders({ btc: [] });
  const refs = { btc: [{ address: 'bc1qrecv0', masterPath: "m/84'/0'/0'/0/0" }, { address: 'bc1qchg0', masterPath: "m/84'/0'/0'/1/0" }] };
  await readPendingUtxoHistory(providers, ADDRESSES, [btcSpend], refs as never);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /^btc:multi:/);
  assert.match(calls[0]!, /bc1qrecv0/);
  assert.match(calls[0]!, /bc1qchg0/);
});

test('a failed or throwing read is unknown, and the spend stays deducted', async () => {
  for (const failure of ['error', new Error('socket hang up')] as const) {
    const { providers } = fakeProviders({ btc: failure });
    const out = await readPendingUtxoHistory(providers, ADDRESSES, [btcSpend], undefined);
    assert.equal(out.btc, null);
    const now = T0 + 3 * 60 * 60_000;
    const kept = reconcileAfterBalanceRefresh([btcSpend], { btc: {} }, out, now);
    assert.ok(utxoAvailableDeduction(kept, 'btc', 0n, now) > 0n, 'released on a failed read');
  }
});

test('an hour-old spend the backend still lists unconfirmed stays deducted; once mined it leaves', async () => {
  const later = T0 + 75 * 60_000;
  const pending = fakeProviders({ btc: [{ txid: btcSpend.txHash, height: 0 }] });
  const keptPending = reconcileAfterBalanceRefresh(
    [btcSpend],
    { btc: {} },
    await readPendingUtxoHistory(pending.providers, ADDRESSES, [btcSpend], undefined),
    later,
  );
  assert.equal(utxoAvailableDeduction(keptPending, 'btc', 0n, later), 3154n);

  const mined = fakeProviders({ btc: [{ txid: btcSpend.txHash, height: 900_000 }] });
  const keptMined = reconcileAfterBalanceRefresh(
    [btcSpend],
    { btc: {} },
    await readPendingUtxoHistory(mined.providers, ADDRESSES, [btcSpend], undefined),
    later,
  );
  assert.deepEqual(keptMined, []);
});
