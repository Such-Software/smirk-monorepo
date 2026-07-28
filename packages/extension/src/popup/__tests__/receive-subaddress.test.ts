/**
 * Receive-subaddress issuance counter + address resolution (Lane 4).
 *
 * What is locked in here:
 *   - Ship-dark: with `ENABLE_SUBADDRESS_RECEIVE` off, `resolveAddressForAsset`
 *     returns the PRIMARY address for xmr/wow and never touches storage.
 *   - Idempotent reads: repeated `resolveAddressForAsset` calls at a fixed
 *     issued index return the identical string and never advance the counter.
 *     This is the invariant that survives ReceiveScreen's re-render storm (the
 *     shell hands it an inline closure, so its address effect re-fires on every
 *     render).
 *   - Money gate G4: the counter refuses to issue a minor index the SERVER has
 *     not confirmed provisioned. A failed, absent, or too-low provisioning
 *     answer blocks issuance instead of guessing a ceiling. An unprovisioned
 *     subaddress is not scanned by the LWS, so funds sent to it would be
 *     invisible to the wallet.
 *   - Monotonic issuance under concurrency.
 *
 * The subaddress derivation itself is cross-checked against monero-oxide
 * reference vectors in @smirk/core's address.test.ts; the same reference keys
 * are reused here so the expected strings are the audited ones.
 */

import './_chrome-stub';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryStorage, xmrSubaddress, wowSubaddress, type UnlockedWallet } from '@smirk/core';

import {
  PROVISION_BATCH,
  ProvisionCeilingError,
  backendScope,
  ReceiveSubaddressIndex,
  receiveSubaddrIndexFor,
  resetReceiveSubaddrCache,
  setReceiveSubaddrStorage,
  subaddressReceiveEnabled,
} from '../receive-subaddress-index';
import { primaryAddressForAsset, resolveAddressForAsset } from '../address';

// ---- fixtures ---------------------------------------------------------------

const hexToBytes = (h: string): Uint8Array =>
  new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));

// Same reference keypair @smirk/core's address.test.ts checks against
// monero-oxide, so the derived subaddresses here are the audited ones.
const REF_SPEND_PUB = hexToBytes('4faa93763d0702316ddef05a7921b30b30e81530b44cf9f35773ffee16f68638');
const REF_VIEW_PRIV = new Uint8Array(32).fill(7);

const PRIMARY_XMR = '4primary-xmr-address';
const PRIMARY_WOW = 'Wo-primary-wow-address';

function makeWallet(fingerprint = 'fp-test'): UnlockedWallet {
  const cn = {
    privateSpendKey: new Uint8Array(32).fill(3),
    privateViewKey: REF_VIEW_PRIV,
    publicSpendKey: REF_SPEND_PUB,
    publicViewKey: new Uint8Array(32).fill(9),
  };
  return {
    fingerprint,
    keys: { xmr: cn, wow: cn },
    addresses: { xmr: PRIMARY_XMR, wow: PRIMARY_WOW, btc: 'bc1qbtc', ltc: 'ltc1qltc' },
  } as unknown as UnlockedWallet;
}

type FlagHost = { __SMIRK_ENABLE_SUBADDRESS_RECEIVE__?: unknown };

function setFlag(on: boolean | undefined): void {
  const g = globalThis as FlagHost;
  if (on === undefined) delete g.__SMIRK_ENABLE_SUBADDRESS_RECEIVE__;
  else g.__SMIRK_ENABLE_SUBADDRESS_RECEIVE__ = on;
}

/** A provisioner that always grants exactly what was asked for. */
const generous = async (maxMinor: number): Promise<number> => maxMinor;

/** A provisioner that grants a fixed ceiling regardless of the ask (the real
 *  shape when the LWS caps the batch at its own `--max-subaddresses`). */
const capped = (ceiling: number) => async (): Promise<number> => ceiling;

/** A provisioner that fails (route 404, backend feature off, network down). */
const failing = async (): Promise<number> => {
  throw new Error('provision route unavailable');
};

let storage: InMemoryStorage;

beforeEach(() => {
  storage = new InMemoryStorage();
  setReceiveSubaddrStorage(storage);
  resetReceiveSubaddrCache();
  setFlag(undefined);
});

afterEach(() => {
  setReceiveSubaddrStorage(null);
  resetReceiveSubaddrCache();
  setFlag(undefined);
});

// ---- ship-dark --------------------------------------------------------------

test('flag defaults OFF', () => {
  assert.equal(subaddressReceiveEnabled(), false);
});

test('flag OFF: xmr/wow resolve to the primary address, exactly as today', async () => {
  const w = makeWallet();
  assert.equal(await resolveAddressForAsset(w, 'xmr'), PRIMARY_XMR);
  assert.equal(await resolveAddressForAsset(w, 'wow'), PRIMARY_WOW);
  assert.equal(await resolveAddressForAsset(w, 'btc'), 'bc1qbtc');
});

test('flag OFF: an already-advanced counter is ignored (turning the flag off reverts cleanly)', async () => {
  const w = makeWallet();
  setFlag(true);
  await receiveSubaddrIndexFor(w.fingerprint, 'xmr').advance(generous);
  assert.notEqual(await resolveAddressForAsset(w, 'xmr'), PRIMARY_XMR);

  setFlag(false);
  assert.equal(await resolveAddressForAsset(w, 'xmr'), PRIMARY_XMR);
});

test('flag ON but nothing issued yet: still the primary address (issued 0 = primary)', async () => {
  setFlag(true);
  const w = makeWallet();
  assert.equal(await resolveAddressForAsset(w, 'xmr'), PRIMARY_XMR);
  assert.equal(await receiveSubaddrIndexFor(w.fingerprint, 'xmr').currentIssued(), 0);
});

// ---- pure, idempotent reads -------------------------------------------------

test('resolveAddressForAsset is a stable pure read across repeated calls at a fixed index', async () => {
  setFlag(true);
  const w = makeWallet();
  const idx = receiveSubaddrIndexFor(w.fingerprint, 'xmr');
  assert.equal(await idx.advance(generous), 1);

  const expected = xmrSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 1);
  // Simulate the ReceiveScreen re-render storm: the effect re-fires on every
  // render because the shell passes an inline closure.
  const seen = new Set<string>();
  for (let i = 0; i < 25; i++) seen.add(await resolveAddressForAsset(w, 'xmr'));

  assert.deepEqual([...seen], [expected], 'every read returned the identical address');
  assert.equal(await idx.currentIssued(), 1, 'reads never advanced the counter');
});

test('concurrent reads do not advance, and wow derives its own (distinct) subaddress', async () => {
  setFlag(true);
  const w = makeWallet();
  await receiveSubaddrIndexFor(w.fingerprint, 'wow').advance(generous);

  const results = await Promise.all(
    Array.from({ length: 12 }, () => resolveAddressForAsset(w, 'wow')),
  );
  const expected = wowSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 1);
  assert.ok(results.every((r) => r === expected));
  assert.notEqual(expected, xmrSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 1));
  assert.equal(await receiveSubaddrIndexFor(w.fingerprint, 'wow').currentIssued(), 1);
});

test('per-(fingerprint,asset) isolation: two wallets and two assets never share a counter', async () => {
  setFlag(true);
  const a = makeWallet('fp-a');
  const b = makeWallet('fp-b');
  await receiveSubaddrIndexFor('fp-a', 'xmr').advance(generous);
  await receiveSubaddrIndexFor('fp-a', 'xmr').advance(generous);

  assert.equal(await receiveSubaddrIndexFor('fp-a', 'xmr').currentIssued(), 2);
  assert.equal(await receiveSubaddrIndexFor('fp-a', 'wow').currentIssued(), 0);
  assert.equal(await receiveSubaddrIndexFor('fp-b', 'xmr').currentIssued(), 0);
  assert.equal(await resolveAddressForAsset(b, 'xmr'), PRIMARY_XMR);
  assert.equal(await resolveAddressForAsset(a, 'xmr'), xmrSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 2));
});

// ---- money gate G4 ----------------------------------------------------------

test('G4: a failed provisioning refuses to issue and leaves the counter untouched', async () => {
  setFlag(true);
  const w = makeWallet();
  const idx = receiveSubaddrIndexFor(w.fingerprint, 'xmr');

  await assert.rejects(() => idx.advance(failing), ProvisionCeilingError);
  assert.equal(await idx.currentIssued(), 0, 'no index was burned');
  assert.equal(
    await resolveAddressForAsset(w, 'xmr'),
    PRIMARY_XMR,
    'the screen keeps showing the primary address rather than an unscanned subaddress',
  );
});

test('G4: a ceiling below the candidate refuses (the LWS granted less than we asked for)', async () => {
  setFlag(true);
  const idx = new ReceiveSubaddressIndex(storage, 'fp-cap', 'xmr');

  // The server will only ever confirm minor 3.
  assert.equal(await idx.advance(capped(3)), 1);
  assert.equal(await idx.advance(capped(3)), 2);
  assert.equal(await idx.advance(capped(3)), 3);

  await assert.rejects(() => idx.advance(capped(3)), ProvisionCeilingError);
  assert.equal(await idx.currentIssued(), 3, 'stopped exactly at the provisioned ceiling');
});

test('G4: the ceiling is never inferred locally, a nonsense answer blocks issuance', async () => {
  setFlag(true);
  const idx = new ReceiveSubaddressIndex(storage, 'fp-nan', 'xmr');
  const garbage = async (): Promise<number> => Number.NaN;
  await assert.rejects(() => idx.advance(garbage), ProvisionCeilingError);
  assert.equal(await idx.currentIssued(), 0);
});

test('G4: a shrinking server ceiling blocks further issuance (no max() with stale local state)', async () => {
  setFlag(true);
  const idx = new ReceiveSubaddressIndex(storage, 'fp-shrink', 'xmr');
  assert.equal(await idx.advance(capped(20)), 1);
  assert.equal((await idx.read()).provisionedCeiling, 20);

  // LWS reset / --max-subaddresses lowered: it now only confirms minor 1.
  await assert.rejects(() => idx.advance(capped(1)), ProvisionCeilingError);
  assert.equal((await idx.read()).provisionedCeiling, 1, 'ceiling follows the server down');
  assert.equal(await idx.currentIssued(), 1);
});

test('EVERY issuance round-trips to re-confirm the ceiling (no local headroom short-cut)', async () => {
  // A cached ceiling is a claim about a machine we do not control: an LWS
  // reset, a lowered --max-subaddresses, or a restore from backup all shrink it
  // without telling us. Issuing inside stale headroom hands out an address
  // nobody is scanning, and funds sent there are invisible to this wallet.
  setFlag(true);
  const idx = new ReceiveSubaddressIndex(storage, 'fp-headroom', 'xmr');
  const asks: number[] = [];
  const counting = async (maxMinor: number): Promise<number> => {
    asks.push(maxMinor);
    return maxMinor;
  };
  await idx.advance(counting);
  await idx.advance(counting);
  await idx.advance(counting);
  assert.deepEqual(asks, [1 + PROVISION_BATCH, 2 + PROVISION_BATCH, 3 + PROVISION_BATCH]);
  assert.equal(await idx.currentIssued(), 3);
});

test('a ceiling that silently shrank between presses cannot be issued into', async () => {
  setFlag(true);
  const idx = new ReceiveSubaddressIndex(storage, 'fp-stale', 'xmr');
  // First press: the server is healthy and grants plenty of headroom.
  assert.equal(await idx.advance(capped(40)), 1);
  // The LWS is reset behind our back. Because the second press re-asks rather
  // than trusting the cached 40, the shrink is observed and issuance stops.
  await assert.rejects(() => idx.advance(capped(0)), ProvisionCeilingError);
  assert.equal(await idx.currentIssued(), 1, 'no unscanned index was handed out');
});

test('a refused advance does not wedge the mutex for later callers', async () => {
  setFlag(true);
  const idx = new ReceiveSubaddressIndex(storage, 'fp-wedge', 'xmr');
  await assert.rejects(() => idx.advance(failing), ProvisionCeilingError);
  assert.equal(await idx.advance(generous), 1);
});

// ---- monotonic issuance -----------------------------------------------------

test('concurrent advances hand out distinct, monotonic indices', async () => {
  setFlag(true);
  const idx = new ReceiveSubaddressIndex(storage, 'fp-conc', 'xmr');
  const got = await Promise.all([
    idx.advance(generous),
    idx.advance(generous),
    idx.advance(generous),
    idx.advance(generous),
  ]);
  assert.deepEqual([...got].sort((x, y) => x - y), [1, 2, 3, 4]);
  assert.equal(await idx.currentIssued(), 4);
});

test('the counter survives a fresh instance (it is persisted, not in-memory)', async () => {
  setFlag(true);
  await new ReceiveSubaddressIndex(storage, 'fp-persist', 'wow').advance(generous);
  const reopened = new ReceiveSubaddressIndex(storage, 'fp-persist', 'wow');
  assert.equal(await reopened.currentIssued(), 1);
});

test('corrupt stored state self-heals DOWN to the primary address, never up', async () => {
  setFlag(true);
  const w = makeWallet('fp-corrupt');
  await storage.set('smirk:receive-subaddr:v2:unknown:fp-corrupt:xmr', {
    issued: 'not-a-number',
    provisionedCeiling: -5,
  });
  assert.equal(await receiveSubaddrIndexFor('fp-corrupt', 'xmr').currentIssued(), 0);
  assert.equal(await resolveAddressForAsset(w, 'xmr'), PRIMARY_XMR);
});

// ---- the ceiling belongs to ONE backend -------------------------------------

test('two backends never share a counter or a ceiling', async () => {
  setFlag(true);
  const A = 'https://api.smirk.cash/api/v1';
  const B = 'https://my-own-node.example/api/v1';
  const w = makeWallet('fp-fed');

  await receiveSubaddrIndexFor(w.fingerprint, 'xmr', A).advance(generous);
  await receiveSubaddrIndexFor(w.fingerprint, 'xmr', A).advance(generous);

  assert.equal(await receiveSubaddrIndexFor(w.fingerprint, 'xmr', A).currentIssued(), 2);
  assert.equal(
    await receiveSubaddrIndexFor(w.fingerprint, 'xmr', B).currentIssued(),
    0,
    'the second backend provisioned nothing, so it starts from the primary address',
  );
  assert.equal(await resolveAddressForAsset(w, 'xmr', B), PRIMARY_XMR);
  assert.notEqual(await resolveAddressForAsset(w, 'xmr', A), PRIMARY_XMR);
});

test('a ceiling earned at one backend cannot authorise issuance at another', async () => {
  setFlag(true);
  const A = 'https://a.example/api/v1';
  const B = 'https://b.example/api/v1';
  const w = makeWallet('fp-fed2');
  // A grants a generous ceiling.
  await receiveSubaddrIndexFor(w.fingerprint, 'xmr', A).advance(generous);
  // B's LWS has subaddresses disabled entirely, so provisioning fails there.
  await assert.rejects(
    () => receiveSubaddrIndexFor(w.fingerprint, 'xmr', B).advance(failing),
    ProvisionCeilingError,
  );
  assert.equal(await receiveSubaddrIndexFor(w.fingerprint, 'xmr', B).currentIssued(), 0);
});

test('backend URLs differing only in trailing slash or case share one counter', async () => {
  setFlag(true);
  const w = makeWallet('fp-norm');
  await receiveSubaddrIndexFor(w.fingerprint, 'xmr', 'https://API.example/api/v1/').advance(
    generous,
  );
  assert.equal(
    await receiveSubaddrIndexFor(w.fingerprint, 'xmr', 'https://api.example/api/v1').currentIssued(),
    1,
  );
});

test('backendScope collapses an absent backend into its own bucket', () => {
  assert.equal(backendScope(undefined), 'unknown');
  assert.equal(backendScope('   '), 'unknown');
  assert.notEqual(backendScope('https://a.example'), backendScope('https://b.example'));
});

// ---- resolve fails closed ---------------------------------------------------

test('a counter that runs past the ceiling shows the PRIMARY address, not the subaddress', async () => {
  // Storage can be moved by things this module does not control: another
  // window, a partially-applied write, a hand-edited profile. Displaying an
  // index the server never provisioned would publish an address the LWS is not
  // scanning, and funds sent to it would be invisible to this wallet.
  setFlag(true);
  const w = makeWallet('fp-overrun');
  await storage.set('smirk:receive-subaddr:v2:unknown:fp-overrun:xmr', {
    issued: 9,
    provisionedCeiling: 4,
  });
  assert.equal(await resolveAddressForAsset(w, 'xmr'), PRIMARY_XMR);
});

test('a subaddress is displayed only while 1 <= issued <= provisionedCeiling', async () => {
  setFlag(true);
  const w = makeWallet('fp-window');
  const key = 'smirk:receive-subaddr:v2:unknown:fp-window:xmr';

  await storage.set(key, { issued: 0, provisionedCeiling: 10 });
  assert.equal(await resolveAddressForAsset(w, 'xmr'), PRIMARY_XMR, 'issued 0 is the primary');

  await storage.set(key, { issued: 3, provisionedCeiling: 3 });
  assert.equal(
    await resolveAddressForAsset(w, 'xmr'),
    xmrSubaddress(REF_SPEND_PUB, REF_VIEW_PRIV, 0, 3),
    'exactly at the ceiling is still provisioned',
  );

  await storage.set(key, { issued: 3, provisionedCeiling: 2 });
  assert.equal(await resolveAddressForAsset(w, 'xmr'), PRIMARY_XMR, 'past the ceiling falls back');
});

// ---- cross-context safety (the mutex only covers this context) --------------

test('a write from another context aborts the issuance instead of clobbering it', async () => {
  setFlag(true);
  const key = 'smirk:receive-subaddr:v2:unknown:fp-cas:xmr';
  const idx = new ReceiveSubaddressIndex(storage, 'fp-cas', 'xmr');

  // Simulate a second window advancing the same counter while this issuance is
  // awaiting its provisioning round-trip. Every attempt sees a fresh value.
  let bumps = 0;
  const racing = async (maxMinor: number): Promise<number> => {
    bumps++;
    await storage.set(key, { version: 1, issued: 10 + bumps, provisionedCeiling: 100 });
    return maxMinor + 100;
  };

  await assert.rejects(() => idx.advance(racing), /another window changed it/);
  // The other context's value survives untouched: no index was clobbered, and
  // none was handed out twice.
  assert.equal((await idx.read()).issued, 10 + bumps);
});

test('a settled write from another context is picked up on the retry', async () => {
  setFlag(true);
  const key = 'smirk:receive-subaddr:v2:unknown:fp-cas2:xmr';
  const idx = new ReceiveSubaddressIndex(storage, 'fp-cas2', 'xmr');

  let raced = false;
  const raceOnce = async (maxMinor: number): Promise<number> => {
    if (!raced) {
      raced = true;
      await storage.set(key, { version: 1, issued: 5, provisionedCeiling: 100 });
    }
    return maxMinor;
  };

  // First attempt loses the race; the retry reads issued=5 and continues from
  // there rather than re-handing out an index the other context already used.
  assert.equal(await idx.advance(raceOnce), 6);
});

// ---- unchanged surfaces -----------------------------------------------------

test('primaryAddressForAsset is flag-independent', async () => {
  const w = makeWallet();
  setFlag(true);
  await receiveSubaddrIndexFor(w.fingerprint, 'xmr').advance(generous);
  assert.equal(primaryAddressForAsset(w, 'xmr'), PRIMARY_XMR);
  assert.notEqual(await resolveAddressForAsset(w, 'xmr'), primaryAddressForAsset(w, 'xmr'));
});

test('non-CryptoNote assets are untouched by the flag', async () => {
  setFlag(true);
  const w = makeWallet();
  assert.equal(await resolveAddressForAsset(w, 'btc'), 'bc1qbtc');
  assert.equal(await resolveAddressForAsset(w, 'ltc'), 'ltc1qltc');
});
