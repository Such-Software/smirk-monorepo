import './_chrome-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMemoDeposit } from '../thorchain';

const VAULT = 'bc1qfh0ze362dd6878wsrysrw8twqv4g92ad5da8v6';
const MEMO = '=:l:ltc1qp6r3vr50h7ehdq5qw2k8alzqwjq76xd5ux38mz:1212699958';

const ctx = {
  kind: 'swap-deposit' as const,
  tradeId: 'thorchain:abc',
  toAsset: 'ltc',
  provider: 'thorchain',
  memo: MEMO,
  amountAtomic: '1000000',
  depositBeforeMs: Date.now() + 5 * 60_000,
};
const seed = { fromAssetId: 'btc', toAddress: VAULT };
const fields = { fromAssetId: 'btc', toAddress: VAULT, amountAtomic: 1_000_000n, sweep: false };
const live = { preflight: async () => undefined };

test('the quoted deposit to a live vault is sent with its memo', async () => {
  assert.deepEqual(await checkMemoDeposit({ ctx, seed, fields, swap: live }), { kind: 'send-with-memo', memo: MEMO });
});

test('an ordinary send, or one the user redirected elsewhere, carries no memo', async () => {
  assert.equal((await checkMemoDeposit({ ctx: undefined, seed, fields, swap: live })).kind, 'not-a-memo-deposit');
  assert.equal((await checkMemoDeposit({ ctx: { kind: 'send' }, seed, fields, swap: live })).kind, 'not-a-memo-deposit');
  const elsewhere = { ...fields, toAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' };
  assert.equal((await checkMemoDeposit({ ctx, seed, fields: elsewhere, swap: live })).kind, 'not-a-memo-deposit');
});

test('anything that changes the quoted deposit to the vault is refused, never sent bare', async () => {
  for (const changed of [
    { ...fields, amountAtomic: 999_999n },
    { ...fields, sweep: true },
    { ...fields, fromAssetId: 'ltc' },
  ]) {
    const r = await checkMemoDeposit({ ctx, seed, fields: changed, swap: live });
    assert.equal(r.kind, 'refuse', JSON.stringify(changed, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }
  const noDeadline = { ...ctx, depositBeforeMs: undefined };
  assert.equal((await checkMemoDeposit({ ctx: noDeadline, seed, fields, swap: live })).kind, 'refuse');
  assert.equal((await checkMemoDeposit({ ctx, seed: undefined, fields, swap: live })).kind, 'refuse');
});

test('a THORChain halt, vault rotation or expiry at signing time refuses the send', async () => {
  const halted = {
    preflight: async () => {
      throw new Error('THORChain BTC: chain is halted.');
    },
  };
  const r = await checkMemoDeposit({ ctx, seed, fields, swap: halted });
  assert.equal(r.kind, 'refuse');
  assert.match((r as { error: string }).error, /halted/);
});
