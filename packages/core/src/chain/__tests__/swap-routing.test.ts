/**
 * Self-sovereign payoff: when a chain is swapped to a non-backend provider (a
 * user's own electrum, lws, or self-hosted backend), the wallet flows must
 * actually USE it, not the Smirk backend. This proves the PR3 reroute makes
 * fetchAllBalances read a swapped-in provider.
 *
 * The backend `api` is a poison object that throws on any access, so the test
 * fails loudly if the swapped (btc) chain ever touches the backend. Hidden
 * (not-visible) chains are zeroed with zero round-trips, which is the shape of
 * the "only show coins the user configured a source for" behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchAllBalances, type BootstrapAuthResult } from '../../wallet-flow';
import { createChainProviders } from '../registry';
import type { UtxoChainProvider } from '../provider';
import type { SmirkApi } from '../../api';
import type { UnlockedWallet } from '../../keystore';

const fakeBytes = (seed: string): Uint8Array => {
  const buf = new Uint8Array(32);
  const s = new TextEncoder().encode(seed);
  for (let i = 0; i < 32; i++) buf[i] = (s[i % s.length] ^ (i + 1)) || 1;
  return buf;
};

function makeWallet(): UnlockedWallet {
  const lws = () => ({
    privateSpendKey: fakeBytes('s'),
    publicSpendKey: fakeBytes('S'),
    privateViewKey: fakeBytes('v'),
    publicViewKey: fakeBytes('V'),
  });
  return {
    fingerprint: 'fp',
    keys: {
      btc: { privateKey: fakeBytes('b'), publicKey: fakeBytes('B') },
      ltc: { privateKey: fakeBytes('l'), publicKey: fakeBytes('L') },
      xmr: lws(),
      wow: lws(),
      grin: { privateKey: fakeBytes('g'), publicKey: fakeBytes('G') },
    },
    addresses: { btc: 'addr-btc', ltc: 'addr-ltc', xmr: 'addr-xmr', wow: 'addr-wow', grin: 'addr-grin' },
  } as unknown as UnlockedWallet;
}

function fakeElectrumBtc(confirmed: number): UtxoChainProvider {
  return {
    asset: 'btc',
    capabilities: {
      model: 'utxo',
      feeModel: 'rate-estimate',
      requiresViewKey: false,
      requiresRegistration: false,
      hasDecoys: false,
      hasRecoveryScan: false,
      serverSideOutputStore: false,
    },
    async getBalance(address) {
      return { data: { asset: 'btc', address, confirmed, unconfirmed: 0, total: confirmed }, status: 200 };
    },
    async listOutputs(address) {
      return { data: { asset: 'btc', address, utxos: [] }, status: 200 };
    },
    async broadcast() {
      return { data: { asset: 'btc', txid: 'electrum-txid' }, status: 200 };
    },
    async getHistory(address) {
      return { data: { asset: 'btc', address, transactions: [] }, status: 200 };
    },
    async getHeight() {
      return { data: { height: 800000 }, status: 200 };
    },
    async estimateFee() {
      return { data: { model: 'rate-estimate', fast: 10, normal: 5, slow: 1 }, status: 200 };
    },
  };
}

test('fetchAllBalances reads a swapped-in (non-backend) provider: bring-your-own-electrum', async () => {
  const poison = new Proxy(
    {},
    {
      get() {
        throw new Error('backend api must not be called for a swapped chain');
      },
    },
  ) as unknown as SmirkApi;

  const providers = createChainProviders(poison);
  providers.setUtxo('btc', fakeElectrumBtc(4242)); // user points btc at their own electrum

  const bootstrap: BootstrapAuthResult = { userId: 'u1', isNew: false };
  const balances = await fetchAllBalances(poison, makeWallet(), bootstrap, {
    providers,
    visibleAssetIds: ['btc'], // self-sovereign shape: only the configured coin is shown
  });

  assert.equal(balances.btc.confirmed, 4242n); // from electrum, not the backend
  assert.equal(balances.ltc.confirmed, 0n); // hidden: zeroed, zero round-trips, backend untouched
});
