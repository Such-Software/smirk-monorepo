import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateMnemonicPhrase } from '../hd';
import { WalletKeystore } from '../keystore';
import { InMemoryStorage } from '../state/platform';
import { chainProviders } from '../chain/registry';
import type { UtxoChainProvider } from '../chain/provider';
import { sweepLegacyBtcLtc } from '../migration';

for (const scenario of ['no funds', 'canceled', 'lock during scan', 'lock during confirmation', 'authorized'] as const) {
  test(`legacy sweep: ${scenario}`, async () => {
    const storage = new InMemoryStorage();
    const keystore = new WalletKeystore(storage);
    const wallet = await keystore.createWallet({
      mnemonic: generateMnemonicPhrase(), password: randomBytes(24).toString('hex'),
    });
    let prompted = false;
    let broadcast = false;
    const original = chainProviders.utxo('ltc');
    chainProviders.setUtxo('ltc', {
      async listOutputs(address: string) {
        if (scenario === 'lock during scan') await keystore.lock();
        return { data: { asset: 'ltc', address, utxos: scenario === 'no funds' ? [] : [
          { txid: '1'.repeat(64), vout: 0, value: 100_000, height: 1 },
        ] } };
      },
      async estimateFee() { return { data: { model: 'rate-estimate', normal: 2 } }; },
      async broadcast() {
        broadcast = true;
        return { data: { asset: 'ltc', txid: '2'.repeat(64) } };
      },
    } as unknown as UtxoChainProvider);
    try {
      const operation = sweepLegacyBtcLtc('ltc', wallet, storage, {
        assertActive: () => keystore.assertUnlockedWallet(wallet),
        async authorize() {
          keystore.assertUnlockedWallet(wallet);
          prompted = true;
          if (scenario === 'canceled') throw new Error('Transfer confirmation canceled');
          if (scenario === 'lock during confirmation') await keystore.lock();
        },
      });
      if (scenario === 'authorized' || scenario === 'no funds') {
        const result = await operation;
        assert.equal(result.status === 'swept', scenario === 'authorized');
      } else {
        await assert.rejects(operation);
      }
      assert.equal(broadcast, scenario === 'authorized');
      assert.equal(prompted, !['no funds', 'lock during scan'].includes(scenario));
      assert.equal(Boolean(await storage.get('smirk_legacy_sweep_ltc')), scenario === 'authorized');
    } finally {
      chainProviders.setUtxo('ltc', original);
      await keystore.lock();
    }
  });
}
