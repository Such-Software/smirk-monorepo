import './_chrome-stub';
import { generateMnemonicPhrase } from '@smirk/core';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1';
import { NETWORK, Transaction, p2pkh, p2wpkh } from '@scure/btc-signer';
import { initialize, bitcoin, grin } from '@smirk/wasm';
import {
  WalletKeystore, InMemoryStorage, reviveForSessionCache, serializeForSessionCache,
  restoreUnlockedFromCache, hasCompleteSigningMaterial,
  chainProviders,
} from '@smirk/core';
import { ensureSessionSecrets, grinExtendedKey, grinKeySource, grinSlatepackSecret } from '../session-signing';
import { canonicalGrinSlatepackAddress, grinRewindHashFromMnemonic } from '../grin-flows';
import { signUtxoSessionTransaction } from '../utxo-session-signing';
import { send } from '../send-handler';
import { walletKeystore } from '../singletons';
import { tryRestoreSessionCache, writeSessionCache, clearSessionCache } from '../session-cache';

const MNEMONIC = generateMnemonicPhrase();
const LTC_NETWORK = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 } as const;

before(async () => {
  (chrome as unknown as { runtime: { getURL: (path: string) => string } }).runtime = { getURL: (path) => path };
  await initialize(await readFile(new URL('../../../../../crates/smirk-wasm/pkg/smirk_wasm_bg.wasm', import.meta.url)));
});

async function restoredWallet() {
  const ks = new WalletKeystore(new InMemoryStorage());
  const fresh = await ks.createWallet({ mnemonic: MNEMONIC, password: 'test-only', iterations: 1_000 });
  await ensureSessionSecrets(fresh);
  const cached = reviveForSessionCache(JSON.parse(JSON.stringify(serializeForSessionCache({
    keys: fresh.keys, addresses: fresh.addresses, fingerprint: fresh.fingerprint,
    sessionSecrets: fresh.sessionSecrets,
  }))));
  const restored = restoreUnlockedFromCache(cached as Parameters<typeof restoreUnlockedFromCache>[0]);
  await ks.lock();
  assert.ok(hasCompleteSigningMaterial(restored));
  assert.ok(restored.mnemonic === undefined);
  assert.ok(restored.seed === undefined);
  return restored;
}

for (const asset of ['btc', 'ltc'] as const) {
  test(`${asset.toUpperCase()} signs primary, fresh receive and change inputs after a real session round trip`, async () => {
    const wallet = await restoredWallet();
    const coin = asset === 'btc' ? 0 : 2;
    const network = asset === 'btc' ? NETWORK : LTC_NETWORK;
    const wasmNetwork = asset === 'btc' ? 'btc-mainnet' : 'ltc-mainnet';
    const paths = [`m/84'/${coin}'/0'/0/0`, `m/84'/${coin}'/0'/0/3`, `m/84'/${coin}'/0'/1/2`];
    const inputs = paths.map((masterPath, index) => ({
      txid: (index + 1).toString(16).padStart(64, '0'), vout: index, value: 10_000,
      masterPath, ownerAddress: bitcoin.deriveAddress(MNEMONIC, '', wasmNetwork, masterPath, 'p2wpkh'),
    }));
    const args = { wallet, asset, inputs, recipientAddress: wallet.addresses[asset], recipientSat: 20_000,
      changeAddress: wallet.addresses[asset], changeSat: 9_000, feeSat: 1_000 };
    const raw = signUtxoSessionTransaction(args);
    const tx = Transaction.fromRaw(hex.decode(raw));
    assert.equal(tx.getOutputAddress(0, network), args.recipientAddress);
    assert.equal(tx.getOutput(0).amount, 20_000n);
    assert.equal(tx.getOutput(1).amount, 9_000n);
    for (let i = 0; i < inputs.length; i++) {
      const witness = tx.getInput(i).finalScriptWitness!;
      const [signature, pubkey] = witness;
      assert.ok(signature && pubkey);
      assert.equal(p2wpkh(pubkey, network).address, inputs[i]!.ownerAddress);
      const sighashType = signature[signature.length - 1]!;
      const digest = tx.preimageWitnessV0(i, p2pkh(pubkey, network).script, sighashType, 10_000n);
      assert.ok(secp256k1.verify(signature.slice(0, -1), digest, pubkey), 'each input signature must verify');
    }
    assert.throws(() => signUtxoSessionTransaction({ ...args, inputs: [{ ...inputs[0]!, masterPath: "m/44'/0'/0'/0/0" }] }));
    assert.throws(() => signUtxoSessionTransaction({ ...args, inputs: [{ ...inputs[0]!, ownerAddress: 'unowned' }] }));
    assert.throws(() => signUtxoSessionTransaction({ ...args, feeSat: 999 }));
    assert.throws(() => signUtxoSessionTransaction({ ...args, inputs: [inputs[0]!, inputs[0]!] }));
  });
}

test('Grin spend, receive, scan and slatepack keys survive without the phrase', async () => {
  const wallet = await restoredWallet();
  const source = grinKeySource(wallet);
  assert.ok(grinExtendedKey(source) === JSON.stringify({
    extended_private_key_hex: (JSON.parse(grin.deriveExtendedKey(MNEMONIC)) as { extended_private_key_hex: string }).extended_private_key_hex,
  }));
  assert.ok(grinSlatepackSecret(source) === grin.slatepackAddressSecret(MNEMONIC, 0));
  assert.equal(canonicalGrinSlatepackAddress(source), grin.slatepackAddress(MNEMONIC, 0, 'mainnet'));
  assert.ok(grinRewindHashFromMnemonic(source) === grinRewindHashFromMnemonic(MNEMONIC));
  const ext = wallet.sessionSecrets!.grin.extendedPrivateKey;
  const legacy = wallet.sessionSecrets!.grin.legacyExtendedPrivateKey;
  assert.ok(hex.encode(ext) !== hex.encode(legacy));
});

test('session subtrees exclude the BIP32 master root and BIP39 seed', async () => {
  const ks = new WalletKeystore(new InMemoryStorage());
  const wallet = await ks.createWallet({ mnemonic: MNEMONIC, password: 'test-only', iterations: 1_000 });
  const secrets = await ensureSessionSecrets(wallet);
  const wire = JSON.stringify(serializeForSessionCache(secrets));
  assert.equal(wire.includes(HDKey.fromMasterSeed(wallet.seed!).privateExtendedKey), false);
  assert.equal(wire.includes(hex.encode(wallet.seed!)), false);
  assert.equal(wire.includes(MNEMONIC), false);
});

test('the actual Litecoin send dispatcher succeeds after popup restore without a mnemonic', async (t) => {
  await walletKeystore.destroy();
  await clearSessionCache();
  const fresh = await walletKeystore.createWallet({ mnemonic: MNEMONIC, password: 'test-only', iterations: 1_000 });
  const expiry = await writeSessionCache(fresh, 240);
  await walletKeystore.lock();
  const wallet = (await tryRestoreSessionCache())!;
  assert.ok(wallet && wallet.mnemonic === undefined);
  const provider = chainProviders.utxo('ltc');
  t.mock.method(provider, 'listOutputs', async () => ({ data: {
    utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 20_000, height: 1 }],
  }, status: 200 }));
  let broadcast = false;
  t.mock.method(provider, 'broadcast', async (raw: string) => {
    const tx = Transaction.fromRaw(hex.decode(raw));
    assert.equal(tx.getOutput(0).amount, 10_000n);
    assert.ok(tx.getInput(0).finalScriptWitness?.length);
    broadcast = true;
    return { data: { txid: 'cd'.repeat(32) }, status: 200 };
  });
  const result = await send(wallet, {
    fromAssetId: 'ltc', amountAtomic: 10_000n, toAddress: wallet.addresses.ltc,
    feeRateSatPerVb: 2, sweep: false,
  });
  assert.ok(result.ok, result.ok ? undefined : result.error);
  assert.ok(broadcast);
  assert.equal(wallet.sessionExpiresAtMs, expiry);
  await walletKeystore.destroy();
  await clearSessionCache();
});

test('a lock during Litecoin input lookup prevents signing and broadcast', async (t) => {
  await walletKeystore.destroy();
  await clearSessionCache();
  const wallet = await walletKeystore.createWallet({ mnemonic: MNEMONIC, password: 'test-only', iterations: 1_000 });
  await writeSessionCache(wallet, 60);
  const provider = chainProviders.utxo('ltc');
  t.mock.method(provider, 'listOutputs', async () => {
    await walletKeystore.lock();
    return { data: { utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 20_000, height: 1 }] }, status: 200 };
  });
  let broadcast = false;
  t.mock.method(provider, 'broadcast', async () => { broadcast = true; return { status: 500 }; });
  await assert.rejects(send(wallet, {
    fromAssetId: 'ltc', amountAtomic: 10_000n, toAddress: wallet.addresses.ltc,
    feeRateSatPerVb: 2, sweep: false,
  }));
  assert.equal(broadcast, false);
  await walletKeystore.destroy();
  await clearSessionCache();
});
