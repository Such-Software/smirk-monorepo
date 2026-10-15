/**
 * The automatic older-address check, and the legacy m/44' sweep convergence,
 * read only while this window is signed in.
 *
 * v0.3.1 regression (live e2e F1, 2026-10-15): the unlock handler started both
 * before sign-in. Lock drops the session token and the bootstrap cache, so the
 * check's reads went out with no token and were refused, and the refusals were
 * kept as the wallet's one automatic result: BTC/LTC `error`, never checked
 * again. These drive the real modules over a fake backend that refuses any
 * wallet read without a bearer token, as smirk-backend-core does.
 */
import './_chrome-stub';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api,
  legacyCheckRecordKey,
  LEGACY_WALLET_KEY,
  type LegacyCheckRecord,
  type UnlockedWallet,
} from '@smirk/core';
import { storage, store, walletKeystore } from '../singletons';
import { maybeAutoLegacyCheck, readLegacyCheck } from '../legacy-funds';
import { startLegacyWorkAfterSignIn } from '../legacy-after-sign-in';

// The BIP-39 test vector. Not a funded wallet.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let seq = 0;
/** A fresh unlock of a fresh wallet: each test owns its stored record. */
const unlock = (): UnlockedWallet =>
  ({
    fingerprint: `autocheck-${++seq}`,
    mnemonic: MNEMONIC,
    // Placeholders: only their presence matters (the sweep refuses to run
    // without a destination); they never equal an older address.
    addresses: { btc: 'current-btc', ltc: 'current-ltc', xmr: 'current-xmr', wow: 'current-wow' },
  }) as unknown as UnlockedWallet;

const LWS_BALANCE = {
  total_received: '0',
  locked_balance: '0',
  pending_balance: '0',
  start_height: 1,
  scanned_height: 1000,
  blockchain_height: 1000,
  spent_outputs: [],
};

type Call = { url: string; address?: string; bearer: boolean };

/**
 * A backend that answers wallet reads only with a bearer token. `refuseAll`
 * models a token the server no longer accepts.
 */
function fakeBackend(opts: { refuseAll?: boolean } = {}) {
  const calls: Call[] = [];
  const state = { refuseAll: opts.refuseAll ?? false };
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = /^Bearer /.test(headers.Authorization ?? '');
    const body = init?.body ? (JSON.parse(String(init.body)) as { address?: string }) : {};
    calls.push({ url, bearer, ...(body.address ? { address: body.address } : {}) });
    if (!bearer || state.refuseAll) {
      return new Response(JSON.stringify({ error: 'Missing or invalid token' }), { status: 401 });
    }
    if (url.includes('/lws/')) return new Response(JSON.stringify(LWS_BALANCE), { status: 200 });
    return new Response(JSON.stringify({ asset: 'btc', address: body.address, utxos: [] }), { status: 200 });
  }) as typeof fetch;
  const restore = mock.method(globalThis, 'fetch', impl);
  return { calls, state, restore: () => restore.mock.restore() };
}

/** Wallet reads, whichever route style the backend speaks. */
const reads = (calls: Call[]) => calls.filter((c) => c.url.includes('/wallet/'));
const isUtxoRead = (c: Call) => !c.url.includes('/lws/');
const errored = (r: LegacyCheckRecord | null) => (r?.findings ?? []).filter((f) => f.state === 'error');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `cond` holds; key derivation and storage hops take a variable number of ticks. */
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!(await cond())) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

let backend: ReturnType<typeof fakeBackend> | null = null;

beforeEach(async () => {
  api.setAccessToken(null);
  await store.update((s) => ({ ...s, ui: { ...s.ui, legacyFundsAutoCheck: true } }));
  await storage.remove(LEGACY_WALLET_KEY);
});

afterEach(() => {
  backend?.restore();
  backend = null;
  api.setAccessToken(null);
});

test('without a sign-in the automatic check reads nothing and keeps nothing', async () => {
  backend = fakeBackend();
  const wallet = unlock();
  await maybeAutoLegacyCheck(wallet);
  assert.deepEqual(reads(backend.calls), []);
  assert.equal(await readLegacyCheck(wallet.fingerprint), null);
});

test('a check refused for sign-in keeps no result, so the next signed-in unlock checks', async () => {
  backend = fakeBackend({ refuseAll: true });
  const wallet = unlock();
  api.setAccessToken('expired-token');
  await maybeAutoLegacyCheck(wallet);
  assert.equal(await readLegacyCheck(wallet.fingerprint), null);

  backend.state.refuseAll = false;
  api.setAccessToken('live-token');
  const record = await maybeAutoLegacyCheck(wallet);
  assert.ok(record);
  assert.deepEqual(errored(record), []);
  assert.deepEqual(errored(await readLegacyCheck(wallet.fingerprint)), []);
});

test('signed in, the check runs once per wallet and reads every older address with the token', async () => {
  backend = fakeBackend();
  const wallet = unlock();
  api.setAccessToken('live-token');
  const first = await maybeAutoLegacyCheck(wallet);
  assert.ok(first);
  assert.equal(first.mode, 'probe');
  assert.deepEqual(errored(first), []);
  const firstReads = reads(backend.calls);
  assert.ok(firstReads.length > 0);
  assert.equal(firstReads.every((c) => c.bearer), true);

  await maybeAutoLegacyCheck(wallet);
  assert.equal(reads(backend.calls).length, firstReads.length);
});

test('two triggers for the same unlock run one check', async () => {
  backend = fakeBackend();
  const wallet = unlock();
  api.setAccessToken('live-token');
  await Promise.all([maybeAutoLegacyCheck(wallet), maybeAutoLegacyCheck(wallet)]);
  const addresses = reads(backend.calls).map((c) => c.address);
  assert.ok(addresses.length > 0);
  assert.equal(new Set(addresses).size, addresses.length, 'an older address was read twice');
});

test('a stored automatic result that could not read an address is checked again; a scan is kept', async () => {
  backend = fakeBackend();
  api.setAccessToken('live-token');
  const unread = (mode: 'probe' | 'scan'): LegacyCheckRecord => ({
    checkedAt: 1,
    mode,
    findings: [{ asset: 'btc', source: 'm44', address: 'old', state: 'error', spendableAtomic: '0', pendingAtomic: '0' }],
  });

  const probed = unlock();
  await storage.set(legacyCheckRecordKey(probed.fingerprint), unread('probe'));
  await maybeAutoLegacyCheck(probed);
  assert.deepEqual(errored(await readLegacyCheck(probed.fingerprint)), []);

  const scanned = unlock();
  const before = reads(backend.calls).length;
  await storage.set(legacyCheckRecordKey(scanned.fingerprint), unread('scan'));
  await maybeAutoLegacyCheck(scanned);
  assert.equal(reads(backend.calls).length, before);
  assert.equal((await readLegacyCheck(scanned.fingerprint))?.mode, 'scan');
});

test('turned off, the automatic check never reads', async () => {
  backend = fakeBackend();
  await store.update((s) => ({ ...s, ui: { ...s.ui, legacyFundsAutoCheck: false } }));
  const wallet = unlock();
  api.setAccessToken('live-token');
  await maybeAutoLegacyCheck(wallet);
  assert.deepEqual(reads(backend.calls), []);
  assert.equal(await readLegacyCheck(wallet.fingerprint), null);
});

test('post-sign-in legacy work sends no unauthenticated read, and converges the sweep once per unlock', async () => {
  backend = fakeBackend();
  // A wallet upgraded from v0.2: the m/44' sweep convergence applies.
  await storage.set(LEGACY_WALLET_KEY, { derivationVersion: 3 });
  const session = mock.method(walletKeystore, 'assertUnlockedWallet', () => undefined);
  try {
    const wallet = unlock();
    const utxoReads = () => reads(backend!.calls).filter(isUtxoRead);
    startLegacyWorkAfterSignIn(wallet);
    await sleep(100);
    assert.deepEqual(reads(backend.calls), [], 'legacy work read before sign-in');

    api.setAccessToken('live-token');
    startLegacyWorkAfterSignIn(wallet);
    // BTC and LTC m/44': each read once by the sweep and once by the check.
    await until(async () => utxoReads().length >= 4 && (await readLegacyCheck(wallet.fingerprint)) !== null, 'the post-sign-in reads');
    const once = utxoReads().length;
    // A second sign-in for the same unlock (retry, backend switch).
    startLegacyWorkAfterSignIn(wallet);
    await sleep(100);
    assert.equal(utxoReads().length, once, 'a second sign-in for one unlock read the older addresses again');
    assert.equal(reads(backend.calls).every((c) => c.bearer), true);
    const perAddress = new Map<string, number>();
    for (const c of utxoReads()) perAddress.set(c.address ?? '', (perAddress.get(c.address ?? '') ?? 0) + 1);
    assert.equal([...perAddress.values()].every((n) => n === 2), true);
    assert.deepEqual(errored(await readLegacyCheck(wallet.fingerprint)), []);
  } finally {
    session.mock.restore();
  }
});
