import './_chrome-stub';
import { generateMnemonicPhrase } from '@smirk/core';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initialize } from '@smirk/wasm';
import {
  InMemoryStorage, WalletKeystore, SESSION_CACHE_KEY, hasCompleteSigningMaterial,
  serializeForSessionCache,
} from '@smirk/core';
import { sessionStorage, walletKeystore } from '../singletons';
import { clearSessionCache, readSessionExpiry, tryRestoreSessionCache, writeSessionCache, writeSessionHandoff } from '../session-cache';
import { lockWalletContexts, subscribeWalletLock, SESSION_LOCK_KEY, acknowledgePasswordUnlock } from '../session-lock';

const MNEMONIC = generateMnemonicPhrase();
const PASSWORD = 'test-only-password';
const HANDOFF_KEY = 'smirk.session.handoff.v1';

before(async () => {
  (chrome as unknown as { runtime: { getURL: (path: string) => string } }).runtime = { getURL: (path) => path };
  await initialize(await readFile(new URL('../../../../../crates/smirk-wasm/pkg/smirk_wasm_bg.wasm', import.meta.url)));
});

beforeEach(async () => {
  await walletKeystore.destroy();
  await clearSessionCache();
  acknowledgePasswordUnlock();
});

const create = () => walletKeystore.createWallet({ mnemonic: MNEMONIC, password: PASSWORD, iterations: 1_000 });

test('refresh and service-worker wake retain a complete open-window session', async () => {
  const wallet = await create();
  await writeSessionCache(wallet, 10);
  const restored = await tryRestoreSessionCache();
  assert.ok(restored === wallet);
  assert.ok(restored && hasCompleteSigningMaterial(restored));
  assert.ok(await readSessionExpiry());
  assert.ok(await sessionStorage.get(SESSION_CACHE_KEY));
  assert.ok((await sessionStorage.get(HANDOFF_KEY)) === null);
});

test('popup reopen preserves complete signing authority and the original grace deadline', async () => {
  const wallet = await create();
  const expiry = await writeSessionCache(wallet, 240);
  await walletKeystore.lock();
  const reopened = await tryRestoreSessionCache();
  assert.ok(reopened && hasCompleteSigningMaterial(reopened));
  assert.ok(reopened.mnemonic === undefined);
  assert.ok(reopened.seed === undefined);
  assert.equal(reopened.sessionExpiresAtMs, expiry);
  assert.equal(await readSessionExpiry(), expiry);
  assert.equal((await walletKeystore.getState()).kind, 'unlocked');
});

test('phrase reveal from a restored session preserves its scoped keys and original expiry', async () => {
  const wallet = await create();
  const expiry = await writeSessionCache(wallet, 240);
  await walletKeystore.lock();
  const restored = await tryRestoreSessionCache();
  assert.ok(restored);
  const phrase = await walletKeystore.readRecoveryPhrase(PASSWORD, restored);
  assert.ok(phrase === MNEMONIC);
  assert.ok(walletKeystore.getUnlocked() === restored);
  assert.equal(restored.sessionExpiresAtMs, expiry);
  assert.ok(restored.mnemonic === undefined);
  assert.ok(restored.seed === undefined);
});

test('legacy warm caches and pop-out handoffs are deleted instead of unlocking', async () => {
  const wallet = await create();
  const legacy = serializeForSessionCache({
    version: 2, _noMnemonic: true, fingerprint: wallet.fingerprint,
    keys: wallet.keys, addresses: wallet.addresses, expiresAtMs: Date.now() + 60_000,
  });
  await sessionStorage.set(SESSION_CACHE_KEY, legacy);
  await sessionStorage.set(HANDOFF_KEY, legacy);
  await walletKeystore.lock();
  assert.ok((await tryRestoreSessionCache()) === null);
  assert.equal((await walletKeystore.getState()).kind, 'locked');
  assert.ok((await sessionStorage.get(SESSION_CACHE_KEY)) === null);
  assert.ok((await sessionStorage.get(HANDOFF_KEY)) === null);
});

test('session cache never stores the recovery phrase, BIP39 seed or master root', async () => {
  const wallet = await create();
  await writeSessionCache(wallet, 60);
  const entry = await sessionStorage.get<Record<string, unknown>>(SESSION_CACHE_KEY);
  assert.ok(entry);
  assert.equal('mnemonic' in entry, false);
  assert.equal('seed' in entry, false);
  assert.equal(JSON.stringify(entry).includes(MNEMONIC), false);
  assert.ok(entry.sessionSecrets);
  await writeSessionCache(wallet, 0);
  assert.equal(await readSessionExpiry(), null);
  assert.ok((await sessionStorage.get(SESSION_CACHE_KEY)) === null);
});

test('a pop-out transfers a window-only session once without changing its policy', async () => {
  const wallet = await create();
  await writeSessionCache(wallet, 0);
  await writeSessionHandoff(wallet);
  await walletKeystore.lock();
  const handoff = await tryRestoreSessionCache();
  assert.ok(handoff && hasCompleteSigningMaterial(handoff));
  assert.equal(handoff.sessionExpiresAtMs, undefined);
  assert.ok((await sessionStorage.get(HANDOFF_KEY)) === null);
  assert.ok((await sessionStorage.get(SESSION_CACHE_KEY)) === null);
  await walletKeystore.lock();
  assert.ok((await tryRestoreSessionCache()) === null);
});

test('a warm session cannot resume at or after its original expiry', async (t) => {
  const wallet = await create();
  const expiry = (await writeSessionCache(wallet, 60))!;
  await walletKeystore.lock();
  t.mock.method(Date, 'now', () => expiry);
  assert.ok((await tryRestoreSessionCache()) === null);
  assert.equal((await walletKeystore.getState()).kind, 'locked');
  assert.ok((await sessionStorage.get(SESSION_CACHE_KEY)) === null);
});

test('an already-open session also locks at its original deadline', async (t) => {
  const wallet = await create();
  const expiry = (await writeSessionCache(wallet, 60))!;
  t.mock.method(Date, 'now', () => expiry);
  assert.ok((await tryRestoreSessionCache()) === null);
  assert.equal((await walletKeystore.getState()).kind, 'locked');
  assert.ok(wallet.mnemonic === undefined);
});

for (const key of [SESSION_CACHE_KEY, HANDOFF_KEY]) {
  test(`a lock during the ${key === HANDOFF_KEY ? 'handoff' : 'cache'} write removes late secret bytes`, async (t) => {
    const wallet = await create();
    let begin!: () => void;
    let release!: () => void;
    const begun = new Promise<void>((resolve) => { begin = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalSet = sessionStorage.set.bind(sessionStorage);
    t.mock.method(sessionStorage, 'set', async (target: string, value: unknown) => {
      if (target === key) { begin(); await gate; }
      await originalSet(target, value);
    });
    const writing = key === HANDOFF_KEY ? writeSessionHandoff(wallet) : writeSessionCache(wallet, 60);
    await begun;
    await lockWalletContexts(walletKeystore, sessionStorage);
    await clearSessionCache();
    release();
    await assert.rejects(writing);
    assert.ok((await sessionStorage.get(key)) === null);
    assert.equal((await walletKeystore.getState()).kind, 'locked');
  });
}

test('an explicit lock rejects a stale cache write completing after invalidation', async () => {
  const wallet = await create();
  await writeSessionCache(wallet, 60);
  const captured = await sessionStorage.get(SESSION_CACHE_KEY);
  await lockWalletContexts(walletKeystore, sessionStorage);
  await clearSessionCache();
  await sessionStorage.set(SESSION_CACHE_KEY, captured);
  assert.ok((await tryRestoreSessionCache()) === null);
  assert.equal((await walletKeystore.getState()).kind, 'locked');
});

test('failed lock publication cannot restore an old cache in the locked window', async (t) => {
  const wallet = await create();
  await writeSessionCache(wallet, 60);
  const original = sessionStorage.set.bind(sessionStorage);
  const mock = t.mock.method(sessionStorage, 'set', async (key: string, value: unknown) => {
    if (key === 'smirk.session.lock.v1') throw new Error('Session storage write failed.');
    return original(key, value);
  });
  await assert.rejects(lockWalletContexts(walletKeystore, sessionStorage));
  assert.ok((await tryRestoreSessionCache()) === null);
  assert.equal((await walletKeystore.getState()).kind, 'locked');
  mock.mock.restore();
  const fresh = await walletKeystore.unlock(PASSWORD);
  assert.ok((await tryRestoreSessionCache()) === fresh);
});

test('explicit lock revokes every open wallet context and a pending handoff', async () => {
  const persistent = new InMemoryStorage();
  const first = new WalletKeystore(persistent);
  const second = new WalletKeystore(persistent);
  await first.createWallet({ mnemonic: MNEMONIC, password: PASSWORD, iterations: 1_000 });
  const secondWallet = await second.unlock(PASSWORD);
  const events = new InMemoryStorage();
  let signalObserved!: () => void;
  const observed = new Promise<void>((resolve) => { signalObserved = resolve; });
  const unsubscribe = subscribeWalletLock(second, events, async () => { signalObserved(); });
  await sessionStorage.set(HANDOFF_KEY, { expiresAtMs: Date.now() + 30_000 });
  await lockWalletContexts(first, events);
  await clearSessionCache();
  await observed;
  unsubscribe();
  assert.equal((await first.getState()).kind, 'locked');
  assert.equal((await second.getState()).kind, 'locked');
  assert.ok(secondWallet.mnemonic === undefined);
  assert.ok((await sessionStorage.get(HANDOFF_KEY)) === null);
});

for (const publication of ['delayed', 'failed', 'completed'] as const) {
  test(`local lock wins over the final restore epoch read when publication is ${publication}`, async (t) => {
    const wallet = await create();
    await writeSessionCache(wallet, 60);
    await walletKeystore.lock();
    let reachedRead!: () => void;
    let releaseRead!: () => void;
    let releasePublication!: () => void;
    const reached = new Promise<void>((resolve) => { reachedRead = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const publicationGate = new Promise<void>((resolve) => { releasePublication = resolve; });
    let cacheRead = false;
    const get = sessionStorage.get.bind(sessionStorage);
    t.mock.method(sessionStorage, 'get', async (key: string) => {
      const value = await get(key);
      if (key === SESSION_CACHE_KEY) cacheRead = true;
      if (key === SESSION_LOCK_KEY && cacheRead) {
        reachedRead();
        await readGate;
      }
      return value;
    });
    const set = sessionStorage.set.bind(sessionStorage);
    t.mock.method(sessionStorage, 'set', async (key: string, value: unknown) => {
      if (key === SESSION_LOCK_KEY) {
        if (publication === 'failed') throw new Error('Session lock publication unavailable');
        if (publication === 'delayed') await publicationGate;
      }
      return set(key, value);
    });
    let detachedKey: Uint8Array | undefined;
    const admit = walletKeystore.admitRestoredSession.bind(walletKeystore);
    t.mock.method(walletKeystore, 'admitRestoredSession', (...args: Parameters<typeof admit>) => {
      detachedKey = args[0].keys.ltc.privateKey;
      return admit(...args);
    });
    const restoring = tryRestoreSessionCache();
    await reached;
    const locking = lockWalletContexts(walletKeystore, sessionStorage);
    if (publication === 'failed') await assert.rejects(locking);
    if (publication === 'completed') await locking;
    releaseRead();
    assert.ok((await restoring) === null);
    assert.ok(detachedKey?.every((byte) => byte === 0));
    assert.equal((await walletKeystore.getState()).kind, 'locked');
    releasePublication();
    if (publication === 'delayed') await locking;
  });
}

test('a window-only handoff expiring during its final epoch read cannot unlock', async (t) => {
  const wallet = await create();
  await writeSessionHandoff(wallet);
  await walletKeystore.lock();
  const entry = await sessionStorage.get<{ expiresAtMs: number }>(HANDOFF_KEY);
  assert.ok(entry);
  const now = Date.now();
  let clock = now;
  let handoffRead = false;
  t.mock.method(Date, 'now', () => clock);
  const get = sessionStorage.get.bind(sessionStorage);
  t.mock.method(sessionStorage, 'get', async (key: string) => {
    const value = await get(key);
    if (key === HANDOFF_KEY) handoffRead = true;
    if (key === SESSION_LOCK_KEY && handoffRead) clock = entry.expiresAtMs;
    return value;
  });
  assert.ok((await tryRestoreSessionCache()) === null);
  assert.equal((await walletKeystore.getState()).kind, 'locked');
});
