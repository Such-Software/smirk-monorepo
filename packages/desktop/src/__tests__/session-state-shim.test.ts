/**
 * The session store on desktop, over the chrome shim.
 *
 * Desktop has one window, and its chrome.storage.local is this shim over the
 * Tauri plugin store, mocked here at the IPC boundary with each call answered
 * in a later task, as the Rust side answers. The session store tells its own
 * writes from the announcements that follow them, so the shim has to announce
 * a write before the write's promise settles, as Chromium does. The store
 * writes one at a time; how the plugin orders replies to concurrent calls is
 * not probed and not relied on here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockIPC } from '@tauri-apps/api/mocks';
import { ChromeLocalStorage, SessionStateStore, withoutWriteStamp, type SessionState } from '@smirk/core';
import { installChromeShim } from '../chrome-shim';

const KEY = 'smirk:popup-state';

/** JSON with object keys sorted, so key order does not count. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
  });
}

/** The plugin store's file, as the Rust side holds it. */
const file = new Map<string, unknown>();

(globalThis as { window?: unknown }).window ??= globalThis;
mockIPC(async (cmd, payload) => {
  const args = (payload ?? {}) as { key?: string; value?: unknown };
  await new Promise((r) => setImmediate(r));
  switch (cmd) {
    case 'plugin:store|load':
      return 1;
    case 'plugin:store|get':
      return [file.get(args.key!) ?? null, file.has(args.key!)];
    case 'plugin:store|set':
      file.set(args.key!, structuredClone(args.value));
      return null;
    case 'plugin:store|delete':
      return file.delete(args.key!);
    case 'plugin:store|save':
      return null;
    case 'plugin:store|entries':
      return [...file.entries()];
    default:
      throw new Error(`unmocked IPC ${cmd}`);
  }
});
installChromeShim();

const chromeApi = (globalThis as unknown as { chrome: typeof chrome }).chrome;

test('the shim announces a write before the write settles', async () => {
  const order: string[] = [];
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && 'order-probe' in changes) order.push('announced');
  };
  chromeApi.storage.onChanged.addListener(listener);
  await chromeApi.storage.local.set({ 'order-probe': { b: 2, a: 1 } });
  order.push('settled');
  chromeApi.storage.onChanged.removeListener(listener);
  assert.deepEqual(order, ['announced', 'settled']);
});

test("Open Send's writes on desktop keep the Send draft, and the store holds what the file holds", async () => {
  const store = new SessionStateStore(new ChromeLocalStorage(chromeApi as never), KEY, null);
  const shown: SessionState[] = [];
  store.subscribe((s) => shown.push(s));
  await store.update((s) => {
    s.route = { current: 'swap' };
    s.wizards['swap-thorchain'] = { step: 0, fields: { step: 2 }, startedAt: 1 };
  });
  await store.update((s) => {
    s.wizards['swap-thorchain']!.fields = { step: 3 };
  });
  await store.update((s) => {
    s.wizards.send = { step: 2, startedAt: 2, fields: { fromAssetId: 'btc', amountText: '0.00015' } };
  });
  await store.update((s) => {
    s.route = { current: 'home/send' };
  });
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  const stored = withoutWriteStamp(file.get(KEY)) as SessionState;
  assert.equal(stored.route.current, 'home/send');
  assert.deepEqual(stored.wizards.send?.fields, { fromAssetId: 'btc', amountText: '0.00015' });
  assert.equal(canonicalJson(await store.load()), canonicalJson(stored), 'the cache holds what the file holds');
  assert.equal(canonicalJson(shown.at(-1)), canonicalJson(stored), 'the last state shown is what the file holds');
  store.destroy();
});
