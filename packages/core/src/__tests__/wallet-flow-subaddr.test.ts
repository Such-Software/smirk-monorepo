/**
 * Balance path: spent-output verification with subaddresses, and the
 * multi-address BTC/LTC read.
 *
 * The defect these lock down is a PHANTOM BALANCE. An XMR/WOW key image
 * folds in the subaddress secret, so a spend of a subaddress output recomputed
 * against the primary index never matches the reported key image. The balance
 * path reads a mismatch as "ring decoy, not really ours" and skips it, so the
 * amount is never subtracted: the wallet keeps displaying money it has already
 * spent, forever, and later sends fail for insufficient funds while the UI
 * insists the funds are there.
 *
 * Also covered: with both feature flags off, every read is byte-identical to
 * the pre-feature behavior: one primary address for BTC/LTC, and an unindexed
 * spend candidate verified against the primary index and skipped on mismatch
 * (so ring decoys are never subtracted).
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchAllBalances, type KeyImageVerifier } from '../wallet-flow';
import type { ChainProviderRegistry } from '../chain';
import type { UnlockedWallet } from '../keystore';
import type { BootstrapAuthResult } from '../wallet-flow';

// ---- fixtures ---------------------------------------------------------------

const KI_PRIMARY = 'aa'.repeat(32);
const KI_SUB_7 = 'bb'.repeat(32);
const KI_OTHER = 'cc'.repeat(32);

let walletSeq = 0;

function makeWallet(): UnlockedWallet {
  // A distinct address per wallet keeps the module-level one-time
  // LWS-registration guard from suppressing a later test's registration.
  const n = ++walletSeq;
  const cn = {
    privateSpendKey: new Uint8Array(32).fill(3),
    privateViewKey: new Uint8Array(32).fill(7),
    publicSpendKey: new Uint8Array(32).fill(5),
    publicViewKey: new Uint8Array(32).fill(9),
  };
  return {
    fingerprint: `fp-${n}`,
    keys: { xmr: cn, wow: cn, btc: {}, ltc: {}, grin: {} },
    addresses: {
      btc: `bc1qprimary${n}`,
      ltc: `ltc1qprimary${n}`,
      xmr: `4primary${n}`,
      wow: `Woprimary${n}`,
      grin: `grin1primary${n}`,
    },
  } as unknown as UnlockedWallet;
}

const bootstrap: BootstrapAuthResult = { userId: 'u1', isNew: false };

interface SpentOut {
  amount: string;
  key_image: string;
  tx_pub_key: string;
  out_index: number;
  subaddr_index?: { major: number; minor: number };
}

interface UtxoCalls {
  getBalance: string[];
  getBalanceMulti: string[][];
  listOutputsMulti: string[][];
}

function makeProviders(opts: {
  spentOutputs?: SpentOut[];
  totalReceived?: string;
  utxoBalance?: { confirmed: number; unconfirmed: number };
  utxosByAddress?: Record<string, number>;
}): { providers: ChainProviderRegistry; utxo: UtxoCalls } {
  const utxo: UtxoCalls = { getBalance: [], getBalanceMulti: [], listOutputsMulti: [] };
  const bal = opts.utxoBalance ?? { confirmed: 0, unconfirmed: 0 };
  const utxoProvider = {
    getBalance: (address: string) => {
      utxo.getBalance.push(address);
      return Promise.resolve({ data: { asset: 'btc', address, ...bal }, status: 200 });
    },
    getBalanceMulti: (addresses: string[]) => {
      utxo.getBalanceMulti.push(addresses);
      return Promise.resolve({ data: { asset: 'btc', address: '', ...bal }, status: 200 });
    },
    listOutputsMulti: (refs: Array<{ address: string; masterPath: string }>) => {
      utxo.listOutputsMulti.push(refs.map((r) => r.address));
      const utxos = refs
        .filter((r) => (opts.utxosByAddress ?? {})[r.address] !== undefined)
        .map((r) => ({
          txid: `${r.address}-tx`,
          vout: 0,
          value: opts.utxosByAddress![r.address]!,
          height: 1,
          address: r.address,
          masterPath: r.masterPath,
        }));
      return Promise.resolve({ data: { asset: 'btc', address: '', utxos }, status: 200 });
    },
  };
  const lwsProvider = {
    registerAccount: () => Promise.resolve({ data: { success: true, message: 'ok' } }),
    getBalance: () =>
      Promise.resolve({
        data: {
          total_received: opts.totalReceived ?? '0',
          locked_balance: '0',
          pending_balance: '0',
          transaction_count: 1,
          blockchain_height: 100,
          start_height: 0,
          scanned_height: 100,
          spent_outputs: opts.spentOutputs ?? [],
        },
        status: 200,
      }),
  };
  const providers = {
    utxo: () => utxoProvider,
    lws: () => lwsProvider,
    grin: () => ({}),
  } as unknown as ChainProviderRegistry;
  return { providers, utxo };
}

/**
 * A verifier standing in for the real wasm one: it reproduces the key image of
 * the output at minor index 7 ONLY when that index is supplied, and the primary
 * one only when no index (or `(0, 0)`) is.
 */
function makeVerifier(): { verify: KeyImageVerifier; seen: Array<[number?, number?]> } {
  const seen: Array<[number?, number?]> = [];
  const verify: KeyImageVerifier = async ({ subaddrMajor, subaddrMinor }) => {
    seen.push([subaddrMajor, subaddrMinor]);
    if (subaddrMajor === 0 && subaddrMinor === 7) return KI_SUB_7;
    if (subaddrMajor === undefined && subaddrMinor === undefined) return KI_PRIMARY;
    if (subaddrMajor === 0 && subaddrMinor === 0) return KI_PRIMARY;
    return KI_OTHER;
  };
  return { verify, seen };
}

const XMR_ONLY = ['xmr'];

afterEach(() => {
  delete (globalThis as { __SMIRK_ENABLE_BTCLTC_FRESH_ADDRS__?: unknown })
    .__SMIRK_ENABLE_BTCLTC_FRESH_ADDRS__;
});

// ---- a subaddress spend must be subtracted --------------------------------

test('a spend of a SUBADDRESS output is subtracted from the balance', async () => {
  const { verify, seen } = makeVerifier();
  const { providers } = makeProviders({
    totalReceived: '1000',
    spentOutputs: [
      {
        amount: '400',
        key_image: KI_SUB_7,
        tx_pub_key: 'tx',
        out_index: 0,
        subaddr_index: { major: 0, minor: 7 },
      },
    ],
  });

  const b = await fetchAllBalances(makeWallet(), bootstrap, {
    providers,
    verifyKeyImage: verify,
    visibleAssetIds: XMR_ONLY,
  });

  assert.deepEqual(seen, [[0, 7]], 'the spend record index reached the verifier');
  assert.equal(b.xmr.confirmed, 600n, 'the spent 400 is gone from the balance');
  assert.deepEqual(b.xmr.verifiedSpentInputs, [KI_SUB_7]);
});

test('without the index the same spend would be missed, which is the phantom balance', async () => {
  // The verifier is only handed what the balance path gives it. Strip the index
  // off the spend record in non-strict mode and the recomputation lands on the
  // primary key image, mismatches, and the amount is never subtracted. This is
  // the exact shape of the bug, asserted so a regression is visible.
  const { verify } = makeVerifier();
  const { providers } = makeProviders({
    totalReceived: '1000',
    spentOutputs: [{ amount: '400', key_image: KI_SUB_7, tx_pub_key: 'tx', out_index: 0 }],
  });
  const b = await fetchAllBalances(makeWallet(), bootstrap, {
    providers,
    verifyKeyImage: verify,
    visibleAssetIds: XMR_ONLY,
  });
  assert.equal(b.xmr.confirmed, 1000n);
});

test('strict mode fails CLOSED on a spend record with no index: it counts as spent', async () => {
  const { verify } = makeVerifier();
  const { providers } = makeProviders({
    totalReceived: '1000',
    spentOutputs: [{ amount: '400', key_image: KI_SUB_7, tx_pub_key: 'tx', out_index: 0 }],
  });
  const b = await fetchAllBalances(makeWallet(), bootstrap, {
    providers,
    verifyKeyImage: verify,
    visibleAssetIds: XMR_ONLY,
    strictSpentSubaddrIndex: true,
  });
  assert.equal(b.xmr.confirmed, 600n, 'unverifiable candidates under-report, never over-report');
  assert.equal(
    b.xmr.verifiedSpentInputs,
    undefined,
    'an unverified key image is not reported as verified',
  );
});

test('strict mode counts a verifier failure as spent rather than leaving it on screen', async () => {
  const exploding: KeyImageVerifier = async () => {
    throw new Error('wasm unavailable');
  };
  const { providers } = makeProviders({
    totalReceived: '1000',
    spentOutputs: [
      {
        amount: '250',
        key_image: KI_SUB_7,
        tx_pub_key: 'tx',
        out_index: 0,
        subaddr_index: { major: 0, minor: 7 },
      },
    ],
  });
  const b = await fetchAllBalances(makeWallet(), bootstrap, {
    providers,
    verifyKeyImage: exploding,
    visibleAssetIds: XMR_ONLY,
    strictSpentSubaddrIndex: true,
  });
  assert.equal(b.xmr.confirmed, 750n);
});

test('a real ring decoy on a subaddress is still skipped, even in strict mode', async () => {
  const { verify } = makeVerifier();
  const { providers } = makeProviders({
    totalReceived: '1000',
    spentOutputs: [
      {
        // The LWS flagged one of our subaddress outputs as a candidate, but it
        // is a decoy in someone else's ring: our recomputation (with the right
        // index) does not reproduce the reported key image.
        amount: '400',
        key_image: 'dd'.repeat(32),
        tx_pub_key: 'tx',
        out_index: 0,
        subaddr_index: { major: 0, minor: 7 },
      },
    ],
  });
  const b = await fetchAllBalances(makeWallet(), bootstrap, {
    providers,
    verifyKeyImage: verify,
    visibleAssetIds: XMR_ONLY,
    strictSpentSubaddrIndex: true,
  });
  assert.equal(b.xmr.confirmed, 1000n, 'decoys are never subtracted');
});

// ---- flag-off: unchanged behavior ------------------------------------------

test('flag off: a primary spend verifies with NO index arguments at all', async () => {
  const { verify, seen } = makeVerifier();
  const { providers } = makeProviders({
    totalReceived: '900',
    spentOutputs: [{ amount: '100', key_image: KI_PRIMARY, tx_pub_key: 'tx', out_index: 3 }],
  });
  const b = await fetchAllBalances(makeWallet(), bootstrap, {
    providers,
    verifyKeyImage: verify,
    visibleAssetIds: XMR_ONLY,
  });
  assert.deepEqual(seen, [[undefined, undefined]], 'the pre-subaddress call, byte for byte');
  assert.equal(b.xmr.confirmed, 800n);
});

test('flag off: an unindexed decoy candidate is still skipped, not subtracted', async () => {
  const { verify } = makeVerifier();
  const { providers } = makeProviders({
    totalReceived: '900',
    spentOutputs: [{ amount: '100', key_image: KI_OTHER, tx_pub_key: 'tx', out_index: 3 }],
  });
  const b = await fetchAllBalances(makeWallet(), bootstrap, {
    providers,
    verifyKeyImage: verify,
    visibleAssetIds: XMR_ONLY,
  });
  assert.equal(b.xmr.confirmed, 900n, 'over-subtracting decoys would show 0 with funds present');
});

test('flag off: an explicit primary (0,0) index is passed through and still matches', async () => {
  const { verify, seen } = makeVerifier();
  const { providers } = makeProviders({
    totalReceived: '900',
    spentOutputs: [
      {
        amount: '100',
        key_image: KI_PRIMARY,
        tx_pub_key: 'tx',
        out_index: 3,
        subaddr_index: { major: 0, minor: 0 },
      },
    ],
  });
  const b = await fetchAllBalances(makeWallet(), bootstrap, {
    providers,
    verifyKeyImage: verify,
    visibleAssetIds: XMR_ONLY,
  });
  assert.deepEqual(seen, [[0, 0]]);
  assert.equal(b.xmr.confirmed, 800n);
});

// ---- BTC/LTC: flag gating on the balance read ------------------------------

test('flag off: BTC reads the single primary address even if refs are supplied', async () => {
  const { providers, utxo } = makeProviders({ utxoBalance: { confirmed: 42, unconfirmed: 0 } });
  const wallet = makeWallet();
  const b = await fetchAllBalances(wallet, bootstrap, {
    providers,
    visibleAssetIds: ['btc'],
    utxoAddressRefs: {
      btc: [{ address: 'bc1qother', masterPath: "m/84'/0'/0'/0/1" }],
    },
  });
  assert.deepEqual(utxo.getBalance, [wallet.addresses.btc], 'one primary-address read');
  assert.deepEqual(utxo.getBalanceMulti, [], 'the batch route is never touched');
  assert.deepEqual(utxo.listOutputsMulti, [], 'no discovery round-trip either');
  assert.equal(b.btc.confirmed, 42n);
});

test('flag on: BTC aggregates across the whole ref set', async () => {
  (globalThis as { __SMIRK_ENABLE_BTCLTC_FRESH_ADDRS__?: unknown })
    .__SMIRK_ENABLE_BTCLTC_FRESH_ADDRS__ = true;
  const { providers, utxo } = makeProviders({ utxoBalance: { confirmed: 99, unconfirmed: 1 } });
  const refs = [
    { address: 'bc1qr0', masterPath: "m/84'/0'/0'/0/0" },
    { address: 'bc1qc3', masterPath: "m/84'/0'/0'/1/3" },
  ];
  const b = await fetchAllBalances(makeWallet(), bootstrap, {
    providers,
    visibleAssetIds: ['btc'],
    utxoAddressRefs: { btc: refs },
  });
  assert.deepEqual(utxo.getBalanceMulti, [['bc1qr0', 'bc1qc3']]);
  assert.deepEqual(utxo.getBalance, [], 'the single-address route is not also called');
  assert.equal(b.btc.confirmed, 99n);
  assert.equal(b.btc.pending, 1n);
});

test('flag on: addresses holding outputs are reported back for gap discovery', async () => {
  (globalThis as { __SMIRK_ENABLE_BTCLTC_FRESH_ADDRS__?: unknown })
    .__SMIRK_ENABLE_BTCLTC_FRESH_ADDRS__ = true;
  const { providers } = makeProviders({
    utxoBalance: { confirmed: 5, unconfirmed: 0 },
    utxosByAddress: { bc1qc3: 5 },
  });
  const refs = [
    { address: 'bc1qr0', masterPath: "m/84'/0'/0'/0/0" },
    { address: 'bc1qc3', masterPath: "m/84'/0'/0'/1/3" },
  ];
  const reported: Array<[string, string[]]> = [];
  await fetchAllBalances(makeWallet(), bootstrap, {
    providers,
    visibleAssetIds: ['btc'],
    utxoAddressRefs: { btc: refs },
    onUtxoActivity: (asset, active) => {
      reported.push([asset, active]);
    },
  });
  assert.deepEqual(reported, [['btc', ['bc1qc3']]], 'only the funded change address is reported');
});

test('flag on: a failing discovery read never breaks the balance', async () => {
  (globalThis as { __SMIRK_ENABLE_BTCLTC_FRESH_ADDRS__?: unknown })
    .__SMIRK_ENABLE_BTCLTC_FRESH_ADDRS__ = true;
  const { providers } = makeProviders({ utxoBalance: { confirmed: 8, unconfirmed: 0 } });
  const broken = {
    ...providers,
    utxo: (asset: 'btc' | 'ltc') => ({
      ...providers.utxo(asset),
      listOutputsMulti: () => Promise.reject(new Error('electrum down')),
    }),
  } as unknown as ChainProviderRegistry;

  const b = await fetchAllBalances(makeWallet(), bootstrap, {
    providers: broken,
    visibleAssetIds: ['btc'],
    utxoAddressRefs: { btc: [{ address: 'bc1qr0', masterPath: "m/84'/0'/0'/0/0" }] },
    onUtxoActivity: () => {
      throw new Error('should not be called');
    },
  });
  assert.equal(b.btc.confirmed, 8n);
  assert.equal(b.btc.error, undefined);
});
