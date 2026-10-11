/**
 * Two windows of the extension changing the session state at once.
 *
 * Review of #47, 2026-10-11: another window's write landing anywhere in this
 * window's run of updates was lost. Each later update built on a cache from
 * before that write and saved the whole state over it. At risk: a send a dapp
 * approval window recorded while the popup was writing (its inputs keep the
 * next send off in-flight UTXOs), a swap's in-flight record, a setting.
 *
 * Each window here is a page of one extension. What the browser sends a page
 * (change announcements, read answers, write replies) arrives in order, each
 * as its own task, as probed in Chromium: a write is announced to the writing
 * page before its promise settles, a read is answered in order with the
 * writes, keys sorted. Announcements to the other windows can arrive late.
 * The windows share one navigator.locks, whose grants travel apart from
 * storage's messages.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionStateStore,
  canonicalJson,
  withoutWriteStamp,
  type CrossWindowLock,
  type SessionState,
} from '../session-state';
import type { PendingOutgoingTx } from '../pending-outgoing';
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

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** Let every queued announcement, reply and resync run out. */
async function settled(): Promise<void> {
  for (let i = 0; i < 300; i++) await tick();
}

/** navigator.locks for the windows of one extension: one holder per name, in request order. */
class SharedLock implements CrossWindowLock {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(name: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(name) ?? Promise.resolve()).then(task, task);
    this.tails.set(
      name,
      result.catch(() => {}),
    );
    return result;
  }
}

/** chrome.storage.local for one extension, with a page per window. */
class Extension {
  readonly lock = new SharedLock();
  /** Writes of each key, counted. */
  readonly writes = new Map<string, number>();
  private readonly data = new Map<string, unknown>();
  private readonly pages = new Set<Page>();

  /** @param lag tasks by which an announcement to another window trails its write. */
  constructor(readonly lag: number) {}

  page(make: (extension: Extension) => Page = (extension) => new Page(extension)): Page {
    const page = make(this);
    this.pages.add(page);
    return page;
  }

  /** The session state stored, without the stamp naming its writer. */
  stored(): SessionState {
    return withoutWriteStamp(this.data.get('k')) as SessionState;
  }

  read(key: string): unknown {
    return this.data.has(key) ? sortedCopy(this.data.get(key)) : null;
  }

  /** Apply a write (`undefined` removes) and announce it to every page, the writer first. */
  apply(key: string, value: unknown, writer: Page): void {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, sortedCopy(value));
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
    for (const page of this.pages) {
      page.deliver(() => page.announce(key), page === writer ? 0 : this.lag);
    }
  }
}

class Page implements PlatformStorage {
  private tail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(key: string) => void>();

  constructor(protected readonly extension: Extension) {}

  /** Queue `fn` on this page's channel, `lag` tasks late; whatever follows waits behind it. */
  deliver(fn: () => void, lag = 0): void {
    this.tail = this.tail.then(async () => {
      for (let i = 0; i <= lag; i++) await tick();
      fn();
    });
  }

  announce(key: string): void {
    for (const l of this.listeners) l(key);
  }

  get<T>(key: string): Promise<T | null> {
    const value = this.extension.read(key);
    return new Promise((resolve) => this.deliver(() => resolve(value as T | null)));
  }

  set<T>(key: string, value: T): Promise<void> {
    this.extension.apply(key, value, this);
    return new Promise((resolve) => this.deliver(resolve));
  }

  remove(key: string): Promise<void> {
    this.extension.apply(key, undefined, this);
    return new Promise((resolve) => this.deliver(resolve));
  }

  subscribe(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** A page whose write replies come some tasks after the write, outside its channel. */
class SlowRepliesPage extends Page {
  override set<T>(key: string, value: T): Promise<void> {
    this.extension.apply(key, value, this);
    return (async () => {
      for (let i = 0; i < 8; i++) await tick();
    })();
  }
}

function send(txHash: string): PendingOutgoingTx {
  return { asset: 'btc', txHash, amount: '1000', fee: '10', recipient: 'bc1q', submittedAt: 1 };
}

/** One window of `extension`, sharing its lock unless `locked` is false. */
function windowOf(extension: Extension, locked = true): SessionStateStore {
  return new SessionStateStore(extension.page(), 'k', locked ? extension.lock : null);
}

/** Two loaded windows of one extension; the first has written. */
async function twoWindows(lag: number, locked = true) {
  const extension = new Extension(lag);
  const popup = windowOf(extension, locked);
  const popout = windowOf(extension, locked);
  await popup.update((s) => {
    s.route = { current: 'settings' };
  });
  await settled();
  await popout.load();
  return { extension, popup, popout };
}

async function assertConverged(extension: Extension, ...stores: SessionStateStore[]) {
  const stored = canonicalJson(extension.stored());
  for (const [i, store] of stores.entries()) {
    assert.equal(canonicalJson(await store.load()), stored, `window ${i} holds what storage holds`);
  }
}

for (const lag of [0, 3]) {
  const when = lag === 0 ? 'announced at once' : 'announced late in the other window';

  for (const n of [3, 5, 8]) {
    test(`${when}: another window's write landing anywhere in a run of ${n} updates survives`, async () => {
      for (let off = 0; off <= 6 * n + 6; off++) {
        const { extension, popup, popout } = await twoWindows(lag);
        const run = (async () => {
          for (let i = 0; i < n; i++) {
            await popup.update((s) => {
              s.scroll[`p${i}`] = i;
            });
          }
        })();
        for (let i = 0; i < off; i++) await tick();
        // The approval window records the send it just broadcast.
        await popout.update((s) => {
          s.pendingOutgoing.push(send('approved'));
          s.ui.denomination = 'BTC';
        });
        await run;
        await settled();
        const stored = extension.stored();
        assert.deepEqual(
          stored.pendingOutgoing.map((p) => p.txHash),
          ['approved'],
          `offset ${off}: the recorded send survived`,
        );
        assert.equal(stored.ui.denomination, 'BTC', `offset ${off}: the setting survived`);
        for (let i = 0; i < n; i++) assert.equal(stored.scroll[`p${i}`], i, `offset ${off}: update ${i} applied`);
        await assertConverged(extension, popup, popout);
        popup.destroy();
        popout.destroy();
      }
    });
  }

  test(`${when}: a send recorded by another window survives this window clearing a settled one`, async () => {
    const { extension, popup, popout } = await twoWindows(lag);
    await popup.update((s) => {
      s.pendingOutgoing.push(send('settled'));
    });
    await settled();
    // The popup's balance refresh drops the settled entry, built on the state
    // before the approval window records its send.
    const recorded = popout.update((s) => {
      s.pendingOutgoing.push(send('approved'));
    });
    const cleared = popup.update((s) => {
      s.pendingOutgoing = s.pendingOutgoing.filter((p) => p.txHash !== 'settled');
    });
    await Promise.all([recorded, cleared]);
    await settled();
    assert.deepEqual(
      extension.stored().pendingOutgoing.map((p) => p.txHash),
      ['approved'],
    );
    await assertConverged(extension, popup, popout);
    popup.destroy();
    popout.destroy();
  });

  test(`${when}: another window's write while an update's mutator waits is kept`, async () => {
    const { extension, popup, popout } = await twoWindows(lag);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const slow = popup.update(async (s) => {
      await released;
      s.scroll.home = 120;
    });
    await tick();
    await popout.update((s) => {
      s.ui.denomination = 'BTC';
    });
    release();
    await slow;
    await settled();
    assert.equal(extension.stored().ui.denomination, 'BTC', "the pop-out's change survived");
    assert.equal(extension.stored().scroll.home, 120, "the popup's update applied");
    await assertConverged(extension, popup, popout);
    popup.destroy();
    popout.destroy();
  });

  for (const locked of [true, false]) {
    test(`${when}, ${locked ? 'with' : 'without'} the lock: two windows writing at once end on what storage holds`, async () => {
      for (let off = 0; off < 12; off++) {
        const { extension, popup, popout } = await twoWindows(lag, locked);
        const issued = extension.writes.get('k')!;
        const run = (store: SessionStateStore, name: string) =>
          (async () => {
            for (let i = 0; i < 4; i++) {
              await store.update((s) => {
                s.scroll[`${name}${i}`] = i;
              });
            }
          })();
        const a = run(popup, 'a');
        for (let i = 0; i < off; i++) await tick();
        const b = run(popout, 'b');
        await Promise.all([a, b]);
        await settled();
        assert.equal(extension.writes.get('k')! - issued, 8, `offset ${off}: one write per update, nothing more`);
        await assertConverged(extension, popup, popout);
        if (locked) {
          for (const name of ['a', 'b']) {
            for (let i = 0; i < 4; i++) {
              assert.equal(extension.stored().scroll[`${name}${i}`], i, `offset ${off}: ${name}${i} kept`);
            }
          }
        }
        popup.destroy();
        popout.destroy();
      }
    });
  }

  test(`${when}: an update that changes nothing writes nothing`, async () => {
    // The balance refresh runs one every 25 s in every unlocked window; each
    // write would wake every other window to read the state again.
    const { extension, popup, popout } = await twoWindows(lag);
    const before = extension.writes.get('k');
    for (let i = 0; i < 3; i++) {
      await popup.update((s) => {
        if (s.pendingOutgoing.length === 0) return;
      });
      await settled();
    }
    assert.equal(extension.writes.get('k'), before);
    popup.destroy();
    popout.destroy();
  });

  test(`${when}: each update is written and shown once; its echo, keys sorted, shows nothing more`, async () => {
    const extension = new Extension(lag);
    const store = windowOf(extension);
    await store.load();
    let shown = 0;
    store.subscribe(() => {
      shown += 1;
    });
    for (let i = 0; i < 5; i++) {
      await store.update((s) => {
        s.wizards[`w${i}`] = { step: i, startedAt: i, fields: { z: i, a: [i, { y: 1, b: 2 }] } };
      });
      await settled();
    }
    assert.equal(extension.writes.get('k'), 5, 'one write per update');
    assert.equal(shown, 5, 'one notification per update');
    store.destroy();
  });
}

test("another window's state read while this window's write is in flight is adopted once it settles", async () => {
  // Write replies that trail later announcements, and no lock: the pop-out
  // writes while the popup's write is in flight, and the popup reads it then.
  const extension = new Extension(0);
  const popup = new SessionStateStore(extension.page((e) => new SlowRepliesPage(e)), 'k', null);
  const popout = windowOf(extension, false);
  await popup.load();
  await popout.load();
  const own = popup.update((s) => {
    s.scroll.home = 1;
  });
  for (let i = 0; i < 3; i++) await tick();
  await popout.update((s) => {
    s.ui.denomination = 'BTC';
  });
  await own;
  await settled();
  assert.equal(extension.stored().ui.denomination, 'BTC');
  assert.equal(extension.stored().scroll.home, 1);
  await assertConverged(extension, popup, popout);
  popup.destroy();
  popout.destroy();
});
