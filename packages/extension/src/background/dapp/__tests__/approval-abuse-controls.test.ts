/**
 * Approval-window abuse controls, plus the permission surface Settings
 * lists and revokes through.
 *
 * What is locked in here:
 *   1. Only ONE approval window is ever open at a time. Every consent-gated
 *      dapp method lands in `requestApproval`, and `chrome.windows.create`
 *      steals focus, so an unbounded handler let any page loop the browser
 *      into unusability (and spam the user into clicking through).
 *   2. An origin with no grant yet does not get to hold a place in the
 *      queue: it can generate those requests at will, so it is rejected
 *      while a prompt is open.
 *   3. A window the user dismisses without deciding releases the slot and
 *      resolves as a denial, and the next queued request then proceeds. A
 *      dismissed or failed prompt must never deadlock the queue.
 *   4. `list()` enumerates permission records ONLY (the inject-disabled flag
 *      shares the storage area) and `remove()` drops exactly one, which is
 *      what makes Settings → Connected sites safe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ApprovalRequest,
  OriginPermission,
} from '@such-software/smirk-dapp-api';

import { chromePopupApprovalHandler } from '../approval';
import { chromeStoragePermissionStore } from '../permissions';

type Changes = Record<string, { newValue?: unknown; oldValue?: unknown }>;
type ChangeListener = (changes: Changes, area: string) => void;
type WindowListener = (windowId: number) => void;

/**
 * In-memory `chrome.storage` + `chrome.windows`, enough for the approval
 * flow. Both modules under test touch `chrome.*` only inside their
 * functions, so installing this per test is enough.
 */
function installChrome() {
  const changeListeners: ChangeListener[] = [];
  const removedListeners: WindowListener[] = [];
  const created: Array<{ id: number; url: string }> = [];
  let nextWindowId = 1;

  const area = (name: 'local' | 'session') => {
    const mem = new Map<string, unknown>();
    return {
      async get(keys?: string | string[] | null) {
        const out: Record<string, unknown> = {};
        if (keys === null || keys === undefined) {
          for (const [k, v] of mem) out[k] = v;
          return out;
        }
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          if (mem.has(k)) out[k] = mem.get(k);
        }
        return out;
      },
      async set(items: Record<string, unknown>) {
        const changes: Changes = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: mem.get(k), newValue: v };
          mem.set(k, v);
        }
        // Copy the listener list: `settle` removes its listener from inside
        // the notification, exactly as it does against real storage.
        for (const l of [...changeListeners]) l(changes, name);
      },
      async remove(keys: string | string[]) {
        for (const k of Array.isArray(keys) ? keys : [keys]) mem.delete(k);
      },
    };
  };

  const stub = {
    storage: {
      local: area('local'),
      session: area('session'),
      onChanged: {
        addListener: (l: ChangeListener) => changeListeners.push(l),
        removeListener: (l: ChangeListener) => {
          const i = changeListeners.indexOf(l);
          if (i >= 0) changeListeners.splice(i, 1);
        },
      },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    windows: {
      created,
      async create(opts: { url: string }) {
        const id = nextWindowId++;
        created.push({ id, url: opts.url });
        return { id };
      },
      async remove(_id: number) {
        // The flow closes the window it opened; nothing to track here.
      },
      onRemoved: {
        addListener: (l: WindowListener) => removedListeners.push(l),
        removeListener: (l: WindowListener) => {
          const i = removedListeners.indexOf(l);
          if (i >= 0) removedListeners.splice(i, 1);
        },
      },
    },
    /** The user dismissing the approval window without deciding. */
    fireWindowClosed(id: number) {
      for (const l of [...removedListeners]) l(id);
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = stub;
  return stub;
}

/** Drain the pending microtasks the stubbed promises queue up. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function connectRequest(origin: string): ApprovalRequest {
  return { kind: 'connect', origin: { origin }, requestedAssets: [] };
}

function grant(origin: string, lastUsedAt: number): OriginPermission {
  return { origin, assets: ['btc'], grantedAt: 1_000, lastUsedAt };
}

test('permission store lists every grant and revokes exactly one', async () => {
  const chromeStub = installChrome();
  const store = chromeStoragePermissionStore();
  // A neighbour key in the same storage area: list() must not return it,
  // and revoking a site must not disturb it.
  await chromeStub.storage.local.set({ 'smirk:dapp:inject-disabled': true });

  await store.set(grant('https://a.example', 5_000));
  await store.set(grant('https://b.example', 9_000));

  // Most-recently-used first, which is the order Settings renders.
  assert.deepEqual(
    (await store.list()).map((p) => p.origin),
    ['https://b.example', 'https://a.example'],
  );

  await store.remove('https://a.example');
  assert.deepEqual(
    (await store.list()).map((p) => p.origin),
    ['https://b.example'],
  );
  const neighbour = await chromeStub.storage.local.get(
    'smirk:dapp:inject-disabled',
  );
  assert.equal(neighbour['smirk:dapp:inject-disabled'], true);
});

test('one approval window at a time; unconnected origins are rejected, not queued', async () => {
  const chromeStub = installChrome();
  const permissions = chromeStoragePermissionStore();
  await permissions.set(grant('https://good.example', 5_000));
  const requestApproval = chromePopupApprovalHandler();

  // First request: opens the one window, waits for a decision.
  const first = requestApproval(connectRequest('https://one.example'));
  await tick();
  assert.equal(chromeStub.windows.created.length, 1);

  // A page with no grant cannot pile a second window on top of it.
  await assert.rejects(
    requestApproval(connectRequest('https://evil.example')),
    /already open/,
  );
  assert.equal(chromeStub.windows.created.length, 1);

  // A connected origin queues instead of being refused, but still does not
  // get a window of its own while the first prompt is up.
  const second = requestApproval(connectRequest('https://good.example'));
  await tick();
  assert.equal(chromeStub.windows.created.length, 1);

  // Dismissing the prompt denies it (fail closed) AND releases the slot.
  chromeStub.fireWindowClosed(1);
  assert.deepEqual(await first, { approved: false });
  await tick();
  assert.equal(chromeStub.windows.created.length, 2);

  // Drain the queued one so the test leaves nothing pending.
  chromeStub.fireWindowClosed(2);
  assert.deepEqual(await second, { approved: false });
});
