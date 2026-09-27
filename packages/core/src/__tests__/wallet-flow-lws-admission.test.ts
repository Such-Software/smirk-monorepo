import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllBalances, type BootstrapAuthResult } from '../wallet-flow';
import type { ChainProviderRegistry } from '../chain';
import type { UnlockedWallet } from '../keystore';

function fixture(read?: () => Promise<unknown>) {
  const id = crypto.randomUUID();
  const publicBytes = new Uint8Array(32);
  const wallet = {
    fingerprint: id,
    addresses: { btc: `btc-${id}`, xmr: `xmr-${id}`, wow: `wow-${id}` },
    keys: {
      xmr: { privateSpendKey: publicBytes, privateViewKey: publicBytes },
      wow: { privateSpendKey: publicBytes, privateViewKey: publicBytes },
    },
  } as unknown as UnlockedWallet;
  const calls: string[] = [];
  const registeredHeights: Array<number | undefined> = [];
  const balance = {
    total_received: '500', locked_balance: '0', pending_balance: '0',
    transaction_count: 1, blockchain_height: 1000, start_height: 100,
    scanned_height: 1000, spent_outputs: [],
  };
  const providers = {
    lws: () => ({
      getBalance: async () => { calls.push('balance'); return read ? read() : { data: balance }; },
      registerAccount: async (_user: string, _address: string, _view: string, height?: number) => {
        calls.push('register'); registeredHeights.push(height);
        return { data: { success: true } };
      },
    }),
    utxo: () => ({ getBalance: async () => ({ data: { confirmed: 123, unconfirmed: 0 } }) }),
  } as unknown as ChainProviderRegistry;
  const fetch = (extra: Partial<BootstrapAuthResult> = {}) => fetchAllBalances(
    wallet, { userId: id, isNew: false, ...extra }, { providers, visibleAssetIds: ['xmr', 'btc'] },
  );
  return { calls, registeredHeights, balance, fetch, providers };
}

test('known wallet without a saved height preserves the existing LWS account through read-only evidence', async () => {
  const f = fixture();
  const result = await f.fetch({ restoreState: 'existing' });
  assert.equal(result.xmr.confirmed, 500n);
  assert.equal(result.xmr.error, undefined);
  assert.ok(f.calls.includes('balance'));
  assert.ok(!f.calls.includes('register'));
});

test('missing or unreachable historical coverage refuses create-at-tip without blocking another asset', async () => {
  const reads = [
    async () => ({ error: 'account not found', status: 404 }),
    async () => ({ error: 'upstream unavailable', status: 503 }),
    async () => { throw new Error('connection reset'); },
    async () => ({ data: {} }),
  ];
  for (const read of reads) {
    const f = fixture(read);
    const result = await f.fetch({ restoreState: 'existing' });
    assert.ok(result.xmr.error);
    assert.ok(/scan coverage is unknown/i.test(result.xmr.error));
    assert.ok(!f.calls.includes('register'));
    assert.equal(result.btc.confirmed, 123n);
  }
});

test('a cached new-account label without fresh restore evidence cannot admit a scan', async () => {
  const f = fixture(async () => ({ error: 'account not found' }));
  const result = await f.fetch({ isNew: true });
  assert.ok(result.xmr.error);
  assert.ok(!f.calls.includes('register'));
});

test('explicit new-wallet evidence admits its initial registration before reading balance', async () => {
  const f = fixture();
  const result = await f.fetch({ restoreState: 'new', isNew: true });
  assert.equal(result.xmr.confirmed, 500n);
  assert.ok(f.registeredHeights.includes(undefined));
  assert.ok(f.calls.indexOf('register') < f.calls.indexOf('balance'));
});

test('an explicit historical height admits registration and preserves that exact height', async () => {
  const f = fixture();
  const result = await f.fetch({ restoreState: 'existing', xmrStartHeight: 0 });
  assert.equal(result.xmr.confirmed, 500n);
  assert.ok(f.registeredHeights.includes(0));
  assert.ok(f.calls.indexOf('register') < f.calls.indexOf('balance'));
});

test('failed registration remains an error and can retry without poisoning admission', async () => {
  const f = fixture();
  let unavailable = true;
  const provider = f.providers.lws('xmr');
  const register = provider.registerAccount;
  const sameProvider = { ...provider, registerAccount: async (...args: Parameters<typeof register>) => {
    if (unavailable) return { error: 'registration source unavailable' };
    return register(...args);
  } };
  f.providers.lws = () => sameProvider;
  const first = await f.fetch({ restoreState: 'existing', xmrStartHeight: 100 });
  assert.match(first.xmr.error ?? '', /registration source unavailable/);
  unavailable = false;
  const retried = await f.fetch({ restoreState: 'existing', xmrStartHeight: 100 });
  assert.equal(retried.xmr.error, undefined);
  assert.equal(retried.xmr.confirmed, 500n);
  assert.ok(f.registeredHeights.includes(100));
});

test('malformed registration success cannot admit a balance or suppress a later retry', async () => {
  for (const data of [{}, { success: 'false' }, { success: 'true' }, { success: 1 }, { success: false }]) {
    const f = fixture();
    const provider = f.providers.lws('xmr');
    const register = provider.registerAccount;
    let malformed = true;
    const sameProvider = { ...provider, registerAccount: async (...args: Parameters<typeof register>) => {
      if (malformed) return { data } as never;
      return register(...args);
    } };
    f.providers.lws = () => sameProvider;
    const first = await f.fetch({ restoreState: 'new', isNew: true });
    assert.ok(first.xmr.error);
    assert.ok(!f.calls.includes('balance'));
    malformed = false;
    const retry = await f.fetch({ restoreState: 'new', isNew: true });
    assert.equal(retry.xmr.error, undefined);
    assert.ok(f.calls.includes('register'));
  }
});
