import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Transaction,
  Address,
  OutScript,
  NETWORK,
} from '@scure/btc-signer';
import { hex } from '@scure/base';

import { encryptPrivateKey } from '../crypto';
import {
  decryptLegacyMnemonic,
  detectLegacyWallet,
  legacyBtcLtcKey,
  migrateLegacyWallet,
  sweepLegacyBtcLtc,
  LEGACY_WALLET_KEY,
  V03_KEYSTORE_KEY,
  type LegacyWalletState,
} from '../migration';
import { WalletKeystore, type UnlockedWallet } from '../keystore';
import { InMemoryStorage } from '../state/platform';
import { chainProviders } from '../chain/registry';
import type { UtxoChainProvider } from '../chain/provider';
import type { UtxoEntry } from '../chain/types';

// A well-known BIP-39 test mnemonic (Trezor vector) — NOT a funded wallet.
const MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSWORD = 'correct horse battery staple';

// Frozen blobs produced by the ACTUAL deployed v0.2.4 encryptor (smirk-extension
// working tree == v0.2.4 tag, 0 diff) sealing MNEMONIC with PASSWORD. The
// SHIP-GATE: v0.3 must reproduce the mnemonic from REAL v0.2.4 output, not just a
// core round-trip. Regenerate via encryptPrivateKey in smirk-extension src/lib/crypto.ts.
const REAL_V024 = {
  // sealed at 100000 iters; pbkdf2Iterations ABSENT ⇒ decrypt defaults to 100000
  cohort100k: {
    encryptedSeed:
      '634f7967039c8c116290e0f0877c51c7cbf3fc2e883224c250a0da28c359e63887c27a3944c423142770bd99694d94387595b39cede9359a68c53de0336db6e817a1c93ffc3e52c6fb36c93805745adfbce95734c3d172906382f55ce8989429f6cc928d958799ada2da4d0ef79d35eeb5da0a',
    seedSalt: 'e336567779e04205cacb274036173fd0',
  },
  // sealed at 600000 iters
  cohort600k: {
    encryptedSeed:
      '2b34c65abdfb7c08c44038ce1cbbdc21a157e8ee561316ee7b78a48913501fb192f2bc6cfc5ab3b68efbbf0b5c4f5ba978a15092023b7cea3f755c325aa8ca4291508e67e822a483a42bc370f0b0e47e4acba5556f11640b98c68ad094efd6d0a51376822fd6a38502d722320cad44e9a12997',
    seedSalt: '76d64d0de381982d9b5c2268a7896a17',
  },
} as const;

/**
 * Seal the mnemonic PHRASE bytes exactly as v0.2.x did: XChaCha20-Poly1305 with
 * a PBKDF2-SHA256 key. core `encryptPrivateKey` is byte-identical to the legacy
 * seal (verified), so this produces a genuine v0.2-format `walletState` blob —
 * the KAT then proves the v0.3 decryptor reproduces the mnemonic. Swap in a REAL
 * exported v0.2.4 blob here for the final ship-gate check.
 */
async function sealLikeV02(mnemonic: string, password: string, iterations: number) {
  const { encrypted, salt } = await encryptPrivateKey(
    new TextEncoder().encode(mnemonic),
    password,
    iterations,
  );
  return { encryptedSeed: encrypted, seedSalt: salt };
}

test('decrypt KAT — 600k cohort (pbkdf2Iterations stored)', async () => {
  const s = await sealLikeV02(MNEMONIC, PASSWORD, 600_000);
  const legacy: LegacyWalletState = { ...s, pbkdf2Iterations: 600_000 };
  assert.equal(await decryptLegacyMnemonic(legacy, PASSWORD), MNEMONIC);
});

test('decrypt KAT — 100k legacy cohort (pbkdf2Iterations ABSENT ⇒ 100000)', async () => {
  const s = await sealLikeV02(MNEMONIC, PASSWORD, 100_000);
  // pbkdf2Iterations intentionally absent — decrypt MUST default to 100000.
  const legacy: LegacyWalletState = { ...s };
  assert.equal(await decryptLegacyMnemonic(legacy, PASSWORD), MNEMONIC);
});

test('SHIP-GATE — decrypt a REAL v0.2.4-encoded blob (600k)', async () => {
  const legacy: LegacyWalletState = {
    ...REAL_V024.cohort600k,
    pbkdf2Iterations: 600_000,
  };
  assert.equal(await decryptLegacyMnemonic(legacy, PASSWORD), MNEMONIC);
});

test('SHIP-GATE — decrypt a REAL v0.2.4-encoded blob (100k, iterations absent)', async () => {
  const legacy: LegacyWalletState = { ...REAL_V024.cohort100k };
  assert.equal(await decryptLegacyMnemonic(legacy, PASSWORD), MNEMONIC);
});

test('decrypt — wrong password throws (AEAD tag verify)', async () => {
  const s = await sealLikeV02(MNEMONIC, PASSWORD, 600_000);
  const legacy: LegacyWalletState = { ...s, pbkdf2Iterations: 600_000 };
  await assert.rejects(() => decryptLegacyMnemonic(legacy, 'wrong password'));
});

test('decrypt — wrong iterations (600k blob read as 100k) throws', async () => {
  const s = await sealLikeV02(MNEMONIC, PASSWORD, 600_000);
  // Blob sealed at 600k but no stored count ⇒ decrypt tries 100k ⇒ wrong key ⇒ throw.
  const legacy: LegacyWalletState = { ...s };
  await assert.rejects(() => decryptLegacyMnemonic(legacy, PASSWORD));
});

test('legacyBtcLtcKey — m/44 P2WPKH address (bc1q/ltc1q), 32-byte key', () => {
  const btc = legacyBtcLtcKey(MNEMONIC, 'btc');
  const ltc = legacyBtcLtcKey(MNEMONIC, 'ltc');
  assert.match(btc.address, /^bc1q/);
  assert.match(ltc.address, /^ltc1q/);
  assert.equal(btc.privateKey.length, 32);
  // The whole point of the sweep: the m/44 address differs from what a v0.3
  // (m/84) wallet watches, so the two are not equal.
  assert.notEqual(btc.address, ltc.address);
});

test('detectLegacyWallet — true only with legacy seed AND no v0.3 keystore', async () => {
  const storage = new InMemoryStorage();
  assert.equal(await detectLegacyWallet(storage), false);
  await storage.set(LEGACY_WALLET_KEY, { encryptedSeed: 'ab', seedSalt: 'cd' });
  assert.equal(await detectLegacyWallet(storage), true);
  await storage.set(V03_KEYSTORE_KEY, { version: 1 });
  assert.equal(await detectLegacyWallet(storage), false); // already migrated
});

test('migrateLegacyWallet — reseal a REAL v0.2.4 blob into a v0.3 keystore', async () => {
  const storage = new InMemoryStorage();
  await storage.set(LEGACY_WALLET_KEY, {
    ...REAL_V024.cohort600k,
    pbkdf2Iterations: 600_000,
  });
  const keystore = new WalletKeystore(storage);

  assert.equal(await detectLegacyWallet(storage), true);
  const wallet = await migrateLegacyWallet(keystore, storage, PASSWORD);

  // Seed preserved end to end (decrypt → reseal → unlock).
  assert.equal(wallet.mnemonic, MNEMONIC);
  // The keystore write is the crash-safe commit point — detection flips false.
  assert.equal(await detectLegacyWallet(storage), false);
  // Legacy walletState is KEPT (cleanup is a separate, later step).
  assert.notEqual(await storage.get(LEGACY_WALLET_KEY), null);
  // Idempotent: re-migrating throws (a v0.3 keystore already exists).
  await assert.rejects(() => migrateLegacyWallet(keystore, storage, PASSWORD));
});

// ===========================================================================
// sweepLegacyBtcLtc — m/44' -> m/84' fund sweep (FUND-CRITICAL)
// ===========================================================================

/** A real unlocked v0.3 wallet (m/84' addresses) sealed from MNEMONIC. Built
 *  once — one 600k-PBKDF2 unlock shared across the sweep KATs. */
const WALLET: UnlockedWallet = await new WalletKeystore(
  new InMemoryStorage(),
).createWallet({ mnemonic: MNEMONIC, password: PASSWORD });

const LEGACY_BTC = legacyBtcLtcKey(MNEMONIC, 'btc');

/** A configurable fake UtxoChainProvider that records the address it was asked
 *  to scan and every tx it was asked to broadcast. */
function fakeUtxo(cfg: {
  asset: 'btc' | 'ltc';
  utxos?: UtxoEntry[];
  feeNormal?: number | null;
  listError?: string;
  broadcastError?: string;
  broadcastTxid?: string;
}) {
  const calls = { scanned: [] as string[], broadcasts: [] as string[] };
  const provider = {
    async listOutputs(address: string) {
      calls.scanned.push(address);
      if (cfg.listError) return { error: cfg.listError };
      return { data: { asset: cfg.asset, address, utxos: cfg.utxos ?? [] } };
    },
    async estimateFee() {
      return {
        data: {
          model: 'rate-estimate' as const,
          fast: null,
          normal: cfg.feeNormal ?? null,
          slow: null,
        },
      };
    },
    async broadcast(txHex: string) {
      calls.broadcasts.push(txHex);
      if (cfg.broadcastError) return { error: cfg.broadcastError };
      return { data: { asset: cfg.asset, txid: cfg.broadcastTxid ?? 'f'.repeat(64) } };
    },
  } as unknown as UtxoChainProvider;
  return { provider, calls };
}

/** Swap in a fake provider for `asset`, run `fn`, always restore the real one. */
async function withFakeUtxo<T>(
  asset: 'btc' | 'ltc',
  fake: UtxoChainProvider,
  fn: () => Promise<T>,
): Promise<T> {
  const real = chainProviders.utxo(asset);
  chainProviders.setUtxo(asset, fake);
  try {
    return await fn();
  } finally {
    chainProviders.setUtxo(asset, real);
  }
}

/** Decode a broadcast tx: assert exactly one output, return its amount+address. */
function soleOutput(txHex: string) {
  const tx = Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true });
  assert.equal(tx.outputsLength, 1, 'sweep must be single-output (no change)');
  const out = tx.getOutput(0);
  return {
    amount: out.amount as bigint,
    address: Address(NETWORK).encode(OutScript.decode(out.script!)),
  };
}

const utxo = (txid: string, vout: number, value: number, height: number): UtxoEntry => ({
  txid,
  vout,
  value,
  height,
});

test('sweepLegacyBtcLtc — happy path: scans m/44, pays m/84, subtracts fee, persists txid', async () => {
  const storage = new InMemoryStorage();
  const { provider, calls } = fakeUtxo({
    asset: 'btc',
    utxos: [utxo('a'.repeat(64), 0, 100_000, 100), utxo('b'.repeat(64), 1, 50_000, 101)],
    feeNormal: 5,
    broadcastTxid: 'c'.repeat(64),
  });

  const res = await withFakeUtxo('btc', provider, () =>
    sweepLegacyBtcLtc('btc', WALLET, storage),
  );

  assert.equal(res.status, 'swept');
  assert.equal(res.txid, 'c'.repeat(64));

  // Scanned the LEGACY m/44' address (not the wallet's m/84' address).
  assert.deepEqual(calls.scanned, [LEGACY_BTC.address]);
  assert.notEqual(LEGACY_BTC.address, WALLET.addresses.btc);

  // Fee math: vsize = 11 + 68*2 + 31 = 178; feeSat = ceil(178*5)+1 = 891.
  const out = soleOutput(calls.broadcasts[0]!);
  assert.equal(out.amount, BigInt(150_000 - 891));
  // Destination is the v0.3 m/84' receive address, NEVER the m/44' source.
  assert.equal(out.address, WALLET.addresses.btc);

  // Durable txid record written — the cross-restart double-broadcast guard.
  const rec = await storage.get<{ txid: string }>('smirk_legacy_sweep_btc');
  assert.equal(rec?.txid, 'c'.repeat(64));
});

test('sweepLegacyBtcLtc — already-swept: durable txid short-circuits, never broadcasts', async () => {
  const storage = new InMemoryStorage();
  await storage.set('smirk_legacy_sweep_btc', { txid: 'prior', at: 1 });
  const { provider, calls } = fakeUtxo({ asset: 'btc', utxos: [utxo('a'.repeat(64), 0, 100_000, 100)], feeNormal: 5 });

  const res = await withFakeUtxo('btc', provider, () =>
    sweepLegacyBtcLtc('btc', WALLET, storage),
  );

  assert.equal(res.status, 'already-swept');
  assert.equal(res.txid, 'prior');
  assert.equal(calls.broadcasts.length, 0);
  assert.equal(calls.scanned.length, 0); // short-circuits before any scan
});

test('sweepLegacyBtcLtc — confirmed-only: unconfirmed (height 0) UTXOs are skipped', async () => {
  const storage = new InMemoryStorage();
  const { provider, calls } = fakeUtxo({
    asset: 'btc',
    utxos: [utxo('a'.repeat(64), 0, 100_000, 0)], // height 0 == unconfirmed
    feeNormal: 5,
  });

  const res = await withFakeUtxo('btc', provider, () =>
    sweepLegacyBtcLtc('btc', WALLET, storage),
  );

  assert.equal(res.status, 'skipped');
  assert.match(res.reason ?? '', /no confirmed/);
  assert.equal(calls.broadcasts.length, 0);
});

test('sweepLegacyBtcLtc — dust gate: swept amount below 546 sat is skipped, not broadcast', async () => {
  const storage = new InMemoryStorage();
  // 1 input: vsize = 11+68+31 = 110; feeNormal 2 => feeSat = ceil(110*2)+1 = 221.
  // value 700 => sweepSat = 700-221 = 479 (< 546 dust) => skipped.
  const { provider, calls } = fakeUtxo({
    asset: 'btc',
    utxos: [utxo('a'.repeat(64), 0, 700, 100)],
    feeNormal: 2,
  });

  const res = await withFakeUtxo('btc', provider, () =>
    sweepLegacyBtcLtc('btc', WALLET, storage),
  );

  assert.equal(res.status, 'skipped');
  assert.match(res.reason ?? '', /below dust/);
  assert.equal(calls.broadcasts.length, 0);
  assert.equal(await storage.get('smirk_legacy_sweep_btc'), null); // no record on skip
});

test('sweepLegacyBtcLtc — fee-coverage gate: total <= fee is skipped', async () => {
  const storage = new InMemoryStorage();
  // value 100 << feeSat => sweepSat <= 0 => skipped.
  const { provider, calls } = fakeUtxo({
    asset: 'btc',
    utxos: [utxo('a'.repeat(64), 0, 100, 100)],
    feeNormal: 5,
  });

  const res = await withFakeUtxo('btc', provider, () =>
    sweepLegacyBtcLtc('btc', WALLET, storage),
  );

  assert.equal(res.status, 'skipped');
  assert.match(res.reason ?? '', /<= fee/);
  assert.equal(calls.broadcasts.length, 0);
});

test('sweepLegacyBtcLtc — no legacy funds: empty UTXO set short-circuits', async () => {
  const storage = new InMemoryStorage();
  const { provider, calls } = fakeUtxo({ asset: 'btc', utxos: [], feeNormal: 5 });

  const res = await withFakeUtxo('btc', provider, () =>
    sweepLegacyBtcLtc('btc', WALLET, storage),
  );

  assert.equal(res.status, 'skipped');
  assert.match(res.reason ?? '', /no confirmed legacy funds/);
  assert.equal(calls.broadcasts.length, 0);
});

test('sweepLegacyBtcLtc — locked wallet (no mnemonic) skips before any scan', async () => {
  const storage = new InMemoryStorage();
  const { provider, calls } = fakeUtxo({ asset: 'btc', utxos: [utxo('a'.repeat(64), 0, 100_000, 100)], feeNormal: 5 });
  const locked: UnlockedWallet = { ...WALLET, mnemonic: undefined };

  const res = await withFakeUtxo('btc', provider, () =>
    sweepLegacyBtcLtc('btc', locked, storage),
  );

  assert.equal(res.status, 'skipped');
  assert.match(res.reason ?? '', /unlock/);
  assert.equal(calls.scanned.length, 0);
});

test('sweepLegacyBtcLtc — relay floor is applied (1.0 estimate clamps to 1.1)', async () => {
  const storage = new InMemoryStorage();
  // 1 input vsize 110; at floored 1.1 => feeSat = ceil(110*1.1)+1 = 123
  // (110*1.1 = 121.0000…1 in float, so ceil = 122, +1 = 123).
  // An UNfloored 1.0 would give ceil(110)+1 = 111 — a different output amount,
  // so this asserts the 1.1 floor was actually applied.
  const { provider, calls } = fakeUtxo({
    asset: 'btc',
    utxos: [utxo('a'.repeat(64), 0, 10_000, 100)],
    feeNormal: 1.0,
  });

  const res = await withFakeUtxo('btc', provider, () =>
    sweepLegacyBtcLtc('btc', WALLET, storage),
  );

  assert.equal(res.status, 'swept');
  assert.equal(soleOutput(calls.broadcasts[0]!).amount, BigInt(10_000 - 123));
});

test('sweepLegacyBtcLtc — broadcast failure leaves no durable record (retryable)', async () => {
  const storage = new InMemoryStorage();
  const { provider } = fakeUtxo({
    asset: 'btc',
    utxos: [utxo('a'.repeat(64), 0, 100_000, 100)],
    feeNormal: 5,
    broadcastError: 'rejected by network rules',
  });

  const res = await withFakeUtxo('btc', provider, () =>
    sweepLegacyBtcLtc('btc', WALLET, storage),
  );

  assert.equal(res.status, 'skipped');
  assert.match(res.reason ?? '', /broadcast failed/);
  assert.equal(await storage.get('smirk_legacy_sweep_btc'), null);
});

test('sweepLegacyBtcLtc — LTC path pays the wallet LTC (ltc1q) address', async () => {
  const storage = new InMemoryStorage();
  const legacyLtc = legacyBtcLtcKey(MNEMONIC, 'ltc');
  const { provider, calls } = fakeUtxo({
    asset: 'ltc',
    utxos: [utxo('a'.repeat(64), 0, 200_000, 100)],
    feeNormal: 4,
    broadcastTxid: 'e'.repeat(64),
  });

  const res = await withFakeUtxo('ltc', provider, () =>
    sweepLegacyBtcLtc('ltc', WALLET, storage),
  );

  assert.equal(res.status, 'swept');
  assert.deepEqual(calls.scanned, [legacyLtc.address]);
  assert.match(WALLET.addresses.ltc, /^ltc1q/);
  // Durable record is per-asset — LTC record present, BTC untouched.
  assert.equal((await storage.get<{ txid: string }>('smirk_legacy_sweep_ltc'))?.txid, 'e'.repeat(64));
  assert.equal(await storage.get('smirk_legacy_sweep_btc'), null);
});
