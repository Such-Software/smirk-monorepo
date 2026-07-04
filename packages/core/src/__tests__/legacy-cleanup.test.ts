import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessLegacyCleanupSafety,
  cleanupLegacyWallet,
  LegacyCleanupBlockedError,
  LEGACY_PENDING_TIPS_KEY,
  LEGACY_GRIN_INVOICE_KEY,
  LEGACY_GRIN_RECEIVE_KEY,
} from '../legacy-cleanup';
import { LEGACY_WALLET_KEY, V03_KEYSTORE_KEY } from '../migration';
import { InMemoryStorage } from '../state/platform';
import type { UnlockedWallet } from '../keystore';
import type { ChainProviderRegistry } from '../chain/registry';
import type { UtxoEntry } from '../chain/types';

// A valid BIP-39 test vector — NOT a funded wallet. assessLegacyCleanupSafety
// only reads wallet.mnemonic, so a minimal wallet object is sufficient.
const MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const WALLET = { mnemonic: MNEMONIC } as UnlockedWallet;

const utxo = (value: number, height: number): UtxoEntry => ({
  txid: 'a'.repeat(64),
  vout: 0,
  value,
  height,
});

/** A fake ChainProviderRegistry serving canned utxo listings + LWS balances. */
function fakeProviders(cfg: {
  utxos?: Partial<Record<'btc' | 'ltc', { utxos?: UtxoEntry[]; error?: string }>>;
  lws?: Partial<
    Record<'xmr' | 'wow', { total_received?: number; spent?: number; error?: string }>
  >;
}): ChainProviderRegistry {
  return {
    utxo: (asset: 'btc' | 'ltc') => ({
      async listOutputs(address: string) {
        const c = cfg.utxos?.[asset];
        if (c?.error) return { error: c.error };
        return { data: { asset, address, utxos: c?.utxos ?? [] } };
      },
    }),
    lws: (asset: 'xmr' | 'wow') => ({
      async getBalance(_address: string, _viewKey: string) {
        const c = cfg.lws?.[asset];
        if (c?.error) return { error: c.error };
        return {
          data: {
            total_received: c?.total_received ?? 0,
            spent_outputs: c?.spent ? [{ amount: c.spent }] : [],
          },
        };
      },
    }),
  } as unknown as ChainProviderRegistry;
}

/** Storage pre-seeded with a v0.3 keystore + a legacy walletState (the common
 *  at-cleanup state). Override derivationVersion via `ver`. */
async function seededStorage(ver: 1 | 2 | 3 | undefined = 3) {
  const s = new InMemoryStorage();
  await s.set(V03_KEYSTORE_KEY, { version: 1 });
  await s.set(LEGACY_WALLET_KEY, {
    encryptedSeed: 'ab',
    seedSalt: 'cd',
    ...(ver !== undefined ? { derivationVersion: ver } : {}),
  });
  return s;
}

const EMPTY = fakeProviders({});

test('assess — CHECK 0: missing v0.3 keystore hard-blocks and stops', async () => {
  const s = new InMemoryStorage(); // no keystore
  await s.set(LEGACY_WALLET_KEY, { encryptedSeed: 'ab', seedSalt: 'cd' });
  const r = await assessLegacyCleanupSafety(WALLET, s, EMPTY);
  assert.equal(r.safe, false);
  assert.equal(r.blockers.length, 1);
  assert.equal(r.blockers[0]!.kind, 'keystore-missing');
});

test('assess — CHECK 1: locked wallet (no mnemonic) hard-blocks and stops', async () => {
  const s = await seededStorage();
  const r = await assessLegacyCleanupSafety(
    { mnemonic: undefined } as UnlockedWallet,
    s,
    EMPTY,
  );
  assert.equal(r.safe, false);
  assert.equal(r.blockers.length, 1);
  assert.equal(r.blockers[0]!.kind, 'wallet-locked');
});

test('assess — clean v0.2.4 wallet (v3, empty addrs, no pending) is SAFE', async () => {
  const s = await seededStorage(3);
  const r = await assessLegacyCleanupSafety(WALLET, s, EMPTY);
  assert.equal(r.safe, true);
  assert.deepEqual(r.blockers, []);
});

test('assess — legacy unclaimed pending tip hard-blocks', async () => {
  const s = await seededStorage();
  await s.set(LEGACY_PENDING_TIPS_KEY, [
    { status: 'claimed', asset: 'btc' },
    { status: 'pending', asset: 'ltc', tipId: 't1' },
    { status: 'pending', asset: 'xmr', tipId: 't2' },
  ]);
  const r = await assessLegacyCleanupSafety(WALLET, s, EMPTY);
  assert.equal(r.safe, false);
  const b = r.blockers.find((x) => x.kind === 'unclaimed-tips');
  assert.ok(b && b.kind === 'unclaimed-tips');
  assert.equal(b.count, 2); // only the two 'pending' ones
  assert.deepEqual(b.assets.sort(), ['ltc', 'xmr']);
});

test('assess — grinPendingInvoice hard-blocks; grinPendingReceive (fresh) warns only', async () => {
  const s = await seededStorage();
  await s.set(LEGACY_GRIN_INVOICE_KEY, { slateId: 'x', secretKeyHex: 'deadbeef' });
  const r1 = await assessLegacyCleanupSafety(WALLET, s, EMPTY);
  assert.equal(r1.safe, false);
  assert.ok(
    r1.blockers.some(
      (b) => b.kind === 'grin-in-flight' && b.severity === 'hard',
    ),
  );

  // Fresh receive alone is a WARN — safe stays true.
  const s2 = await seededStorage();
  await s2.set(LEGACY_GRIN_RECEIVE_KEY, { createdAt: Date.now() });
  const r2 = await assessLegacyCleanupSafety(WALLET, s2, EMPTY);
  assert.equal(r2.safe, true);
  assert.ok(
    r2.blockers.some(
      (b) => b.kind === 'grin-in-flight' && b.severity === 'warn',
    ),
  );

  // Expired receive (>24h) produces no blocker at all.
  const s3 = await seededStorage();
  await s3.set(LEGACY_GRIN_RECEIVE_KEY, {
    createdAt: Date.now() - 25 * 60 * 60 * 1000,
  });
  const r3 = await assessLegacyCleanupSafety(WALLET, s3, EMPTY);
  assert.equal(r3.safe, true);
  assert.deepEqual(r3.blockers, []);
});

test('assess — confirmed BTC at m/44 hard-blocks; unconfirmed-only warns', async () => {
  const s = await seededStorage();
  const rHard = await assessLegacyCleanupSafety(
    WALLET,
    s,
    fakeProviders({ utxos: { btc: { utxos: [utxo(100_000, 800_000)] } } }),
  );
  assert.equal(rHard.safe, false);
  const hb = rHard.blockers.find((b) => b.kind === 'btcltc-unswept');
  assert.ok(hb && hb.kind === 'btcltc-unswept');
  assert.equal(hb.severity, 'hard');
  assert.equal(hb.asset, 'btc');
  assert.equal(hb.confirmedSat, 100_000);

  const rWarn = await assessLegacyCleanupSafety(
    WALLET,
    await seededStorage(),
    fakeProviders({ utxos: { ltc: { utxos: [utxo(50_000, 0)] } } }),
  );
  assert.equal(rWarn.safe, true); // unconfirmed-only is advisory
  assert.ok(
    rWarn.blockers.some(
      (b) => b.kind === 'btcltc-unswept' && b.severity === 'warn',
    ),
  );
});

test('assess — BTC listOutputs fetch error fails CLOSED (hard check-failed)', async () => {
  const s = await seededStorage();
  const r = await assessLegacyCleanupSafety(
    WALLET,
    s,
    fakeProviders({ utxos: { btc: { error: 'electrum down' } } }),
  );
  assert.equal(r.safe, false);
  assert.ok(
    r.blockers.some((b) => b.kind === 'check-failed' && b.check === 'btcltc-btc'),
  );
});

test('assess — XMR/WOW v2 with funds hard-blocks; v2 empty is safe; v3 skips the probe', async () => {
  // v2 + funds at the re-derived legacy address -> hard stranded.
  const rFunds = await assessLegacyCleanupSafety(
    WALLET,
    await seededStorage(2),
    fakeProviders({ lws: { xmr: { total_received: 500, spent: 100 } } }),
  );
  assert.equal(rFunds.safe, false);
  const b = rFunds.blockers.find((x) => x.kind === 'xmrwow-stranded');
  assert.ok(b && b.kind === 'xmrwow-stranded');
  assert.equal(b.asset, 'xmr');
  assert.equal(b.derivationVersion, 2);

  // v2 + fully-spent (total_received == spent) -> no stranding.
  const rEmpty = await assessLegacyCleanupSafety(
    WALLET,
    await seededStorage(2),
    fakeProviders({ lws: { xmr: { total_received: 100, spent: 100 }, wow: { total_received: 0 } } }),
  );
  assert.equal(rEmpty.safe, true);
  assert.deepEqual(rEmpty.blockers, []);

  // v3 wallet -> the probe never runs (address already watched by v0.3).
  const rV3 = await assessLegacyCleanupSafety(
    WALLET,
    await seededStorage(3),
    fakeProviders({ lws: { xmr: { total_received: 999, spent: 0 } } }),
  );
  assert.equal(rV3.safe, true);
  assert.equal(
    rV3.blockers.filter((b) => b.kind === 'xmrwow-stranded').length,
    0,
  );
});

test('assess — XMR/WOW v1 balance fetch error fails CLOSED', async () => {
  const r = await assessLegacyCleanupSafety(
    WALLET,
    await seededStorage(1),
    fakeProviders({ lws: { xmr: { error: 'lws unreachable' } } }),
  );
  assert.equal(r.safe, false);
  assert.ok(
    r.blockers.some((b) => b.kind === 'check-failed' && b.check === 'xmrwow-xmr'),
  );
});

test('cleanupLegacyWallet — removes walletState LAST only when safe', async () => {
  const s = await seededStorage(3);
  assert.notEqual(await s.get(LEGACY_WALLET_KEY), null);
  const res = await cleanupLegacyWallet(WALLET, s, EMPTY);
  assert.deepEqual(res.removed, [LEGACY_WALLET_KEY]);
  assert.equal(await s.get(LEGACY_WALLET_KEY), null);
  // Idempotent: a second run is a clean no-op.
  const res2 = await cleanupLegacyWallet(WALLET, s, EMPTY);
  assert.deepEqual(res2.removed, []);
});

test('cleanupLegacyWallet — throws LegacyCleanupBlockedError and deletes NOTHING when blocked', async () => {
  const s = await seededStorage();
  await s.set(LEGACY_GRIN_INVOICE_KEY, { slateId: 'x' });
  await assert.rejects(
    () => cleanupLegacyWallet(WALLET, s, EMPTY),
    (e: unknown) => {
      assert.ok(e instanceof LegacyCleanupBlockedError);
      assert.ok(e.blockers.every((b) => b.severity === 'hard'));
      assert.ok(e.blockers.some((b) => b.kind === 'grin-in-flight'));
      return true;
    },
  );
  // walletState is UNTOUCHED — the beacon stays until the block clears.
  assert.notEqual(await s.get(LEGACY_WALLET_KEY), null);
});
