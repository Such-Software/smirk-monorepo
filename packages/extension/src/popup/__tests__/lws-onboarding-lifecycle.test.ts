import './_chrome-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmirkApi, bootstrapAuth, deriveAllKeys, fetchAllBalances } from '@smirk/core';
import type { UnlockedWallet, ChainProviderRegistry } from '@smirk/core';
import { writeBootstrapCache, readBootstrapCache, clearBootstrapCache } from '../bootstrap-cache';

// Published BIP39 test vector, never a funded wallet.
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('create, finish onboarding, reopen and receive uses the original durable scan boundaries', async (t) => {
  await clearBootstrapCache();
  t.after(clearBootstrapCache);
  const api = new SmirkApi('http://127.0.0.1:18721/api/v1');
  const keys = deriveAllKeys(PHRASE, '', 3);
  const wallet = { fingerprint: crypto.randomUUID(), keys,
    addresses: { btc: 'fixture-btc', ltc: 'fixture-ltc', xmr: `fixture-xmr-${crypto.randomUUID()}`, wow: `fixture-wow-${crypto.randomUUID()}` },
  } as unknown as UnlockedWallet;
  let created = false;
  t.mock.method(api, 'checkRestore', async () => ({ data: created
    ? { exists: true, keysValid: true, xmrStartHeight: 100, wowStartHeight: 200 }
    : { exists: false } }));
  t.mock.method(api, 'extensionRegister', async () => {
    const isNew = !created; created = true;
    return { data: { user: { id: 'lifecycle-user' }, isNew,
      accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 3600 } };
  });
  const first = await bootstrapAuth(api, wallet, { powSolver: async () => null });
  // No balance read happens while onboarding owns the fresh result. This is
  // the real gap: the next popup starts from projected cached login state.
  await writeBootstrapCache({ fingerprint: wallet.fingerprint, backendUrl: api.getBaseUrl(),
    accessToken: 'test-access', bootstrap: first, sessionExpiresAtMs: Date.now() + 60_000 });
  const reopened = await readBootstrapCache(wallet.fingerprint, api.getBaseUrl());
  assert.ok(reopened);
  assert.equal(reopened.bootstrap.restoreState, undefined);
  const registrations: Array<{ asset: string; height: number | undefined }> = [];
  const scanning = new Set<string>();
  const providers = { lws: (asset: 'xmr' | 'wow') => {
    return {
      registerAccount: async (_user: string, _address: string, _view: string, height?: number) => {
        registrations.push({ asset, height });
        // The simulated receipt predates today's tip but follows the retained
        // birthday. Registration at tip would silently exclude it.
        if (height !== undefined && height < (asset === 'xmr' ? 150 : 250)) scanning.add(asset);
        return { data: { success: true } };
      },
      getBalance: async () => scanning.has(asset) ? { data: { total_received: '500', locked_balance: '0', pending_balance: '0',
        transaction_count: 1, blockchain_height: 1000, start_height: asset === 'xmr' ? 100 : 200,
        scanned_height: 1000, spent_outputs: [] } } : { error: 'account not found' },
    };
  } } as unknown as ChainProviderRegistry;
  const balances = await fetchAllBalances(wallet, reopened.bootstrap,
    { providers, visibleAssetIds: ['xmr', 'wow'], backendUrl: api.getBaseUrl() });
  assert.equal(balances.xmr.error, undefined);
  assert.equal(balances.wow.error, undefined);
  assert.equal(balances.xmr.confirmed, 500n);
  assert.equal(balances.wow.confirmed, 500n);
  assert.deepEqual(registrations, [{ asset: 'xmr', height: 100 }, { asset: 'wow', height: 200 }]);
  const cold = await bootstrapAuth(api, wallet, { powSolver: async () => { throw new Error('returning wallet must not solve'); } });
  assert.equal(cold.xmrStartHeight, first.xmrStartHeight);
  assert.equal(cold.wowStartHeight, first.wowStartHeight);
});
