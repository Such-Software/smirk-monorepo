/**
 * SessionStateStore over storage that behaves like chrome.storage.local.
 *
 * Probed in Chromium on 2026-10-11 from an extension page: a write is applied
 * in order and announced to every page, the writing page included, BEFORE the
 * write's promise settles; a read is answered in order with the writes; and a
 * read returns objects with their keys sorted. So a read issued from the
 * announcement of write N answers with N after write N+1 has been issued.
 *
 * The store used to adopt that answer as another window's change. In the
 * live v0.3.1 run (THORChain BTC to LTC, 2026-10-10) the Swap tab's "Open
 * Send" wrote the swap wizard's status step, the Send draft and the route
 * back to back; the stale echo of the first write came back into the cache
 * before the route was written on top of it, and Send opened on its coin
 * chooser with the deposit gone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStateStore, canonicalJson, type SessionState } from '../session-state';
import type { PlatformStorage } from '../platform';

/** Objects rebuilt with sorted keys, as chrome.storage hands them back. */
function sortedCopy<T>(value: T): T {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v === null || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
    return out;
  };
  return sort(JSON.parse(JSON.stringify(value))) as T;
}

/**
 * The page's view of chrome.storage.local. Each browser reply is a task on the
 * page (setImmediate, first in first out, microtasks drained between tasks).
 * Several stores on one instance are several windows of one extension.
 */
class ChromeLikeStorage implements PlatformStorage {
  private readonly data = new Map<string, unknown>();
  private readonly listeners = new Set<(key: string) => void>();

  async get<T>(key: string): Promise<T | null> {
    // Answered in order with the writes: the value as of now.
    const value = this.data.has(key) ? sortedCopy(this.data.get(key)) : null;
    return new Promise((resolve) => setImmediate(() => resolve(value as T | null)));
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, sortedCopy(value));
    return new Promise((resolve) => {
      setImmediate(() => {
        for (const l of this.listeners) l(key);
      });
      setImmediate(resolve);
    });
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
    return new Promise((resolve) => {
      setImmediate(() => {
        for (const l of this.listeners) l(key);
      });
      setImmediate(resolve);
    });
  }

  subscribe(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  peek(key: string): unknown {
    return this.data.get(key) ?? null;
  }
}

/** Let every queued announcement, reply and resync run out. */
async function settled(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

test('the double reproduces the probed order: the announcement comes before the write settles', async () => {
  const storage = new ChromeLikeStorage();
  const order: string[] = [];
  storage.subscribe(() => order.push('announced'));
  await storage.set('k', { b: 1, a: 2 });
  order.push('settled');
  assert.deepEqual(order, ['announced', 'settled']);
  assert.deepEqual(Object.keys((await storage.get<Record<string, number>>('k'))!), ['a', 'b']);
});

test('Open Send: the Send draft written between two other writes is still there afterwards', async () => {
  const storage = new ChromeLikeStorage();
  const store = new SessionStateStore(storage, 'k');
  const notified: SessionState[] = [];
  store.subscribe((s) => notified.push(s));
  await store.update((s) => {
    s.route = { current: 'swap' };
    s.wizards['swap-thorchain'] = { step: 0, fields: { step: 2 }, startedAt: 1 };
  });
  await settled();

  // The handler's three writes, as routes/swap.tsx and SwapTab issue them.
  await store.update((s) => {
    s.wizards['swap-thorchain']!.fields = { step: 3 };
  });
  await store.update((s) => {
    s.wizards.send = { step: 2, startedAt: 2, fields: { fromAssetId: 'btc', amountText: '0.00015' } };
  });
  await store.update((s) => {
    s.route = { current: 'home/send' };
  });
  await settled();

  const stored = storage.peek('k') as SessionState;
  assert.equal(stored.route.current, 'home/send');
  assert.deepEqual(stored.wizards.send?.fields, { fromAssetId: 'btc', amountText: '0.00015' }, 'the Send draft survived');
  assert.equal(stored.wizards.send?.step, 2);
  assert.deepEqual(await store.load(), stored, 'the cache holds what storage holds');
  assert.deepEqual(notified.at(-1), stored, 'the last state shown is what storage holds');
  for (const s of notified.slice(notified.findIndex((x) => x.wizards.send !== undefined))) {
    assert.ok(s.wizards.send, 'once written, the Send draft is never shown missing');
  }
  store.destroy();
});

test('a run of updates leaves cache and storage equal, and every update applied', async () => {
  const storage = new ChromeLikeStorage();
  const store = new SessionStateStore(storage, 'k');
  for (let i = 0; i < 20; i++) {
    await store.update((s) => {
      s.scroll[`screen-${i}`] = i;
    });
  }
  await settled();
  const stored = storage.peek('k') as SessionState;
  for (let i = 0; i < 20; i++) assert.equal(stored.scroll[`screen-${i}`], i, `update ${i} applied`);
  assert.deepEqual(await store.load(), stored);
  store.destroy();
});

test("another window's write is still adopted and shown", async () => {
  const storage = new ChromeLikeStorage();
  const popup = new SessionStateStore(storage, 'k');
  const popout = new SessionStateStore(storage, 'k');
  await popup.load();
  const notified: SessionState[] = [];
  popup.subscribe((s) => notified.push(s));
  await popout.update((s) => {
    s.route = { current: 'inbox' };
  });
  await settled();
  assert.equal((await popup.load()).route.current, 'inbox');
  assert.equal(notified.at(-1)?.route.current, 'inbox');
  popup.destroy();
  popout.destroy();
});

test("another window's write read while this window's writes land does not replace the newer state", async () => {
  const storage = new ChromeLikeStorage();
  const popup = new SessionStateStore(storage, 'k');
  const popout = new SessionStateStore(storage, 'k');
  await popup.load();
  await popout.load();
  // The pop-out writes right behind the popup's first write; the popup's
  // second write then lands last and is what storage keeps.
  const first = popup.update((s) => {
    s.route = { current: 'swap' };
  });
  const foreign = popout.update((s) => {
    s.route = { current: 'settings' };
  });
  await Promise.all([first, foreign]);
  await popup.update((s) => {
    s.route = { current: 'home/send' };
  });
  await settled();
  const stored = storage.peek('k') as SessionState;
  assert.equal(stored.route.current, 'home/send');
  assert.deepEqual(await popup.load(), stored, "the popup's cache holds what storage holds");
  assert.deepEqual(await popout.load(), stored, "the pop-out's cache holds what storage holds");
  popup.destroy();
  popout.destroy();
});

test('canonicalJson ignores key order at every depth and keeps array order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, 1], c: null } }), canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 }));
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
});
