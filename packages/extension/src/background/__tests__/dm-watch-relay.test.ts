/**
 * The background DM watch beacons only to the relay its backend advertises.
 *
 * Review of #46: `DM_WATCH_SET` bound whatever relay the popup sent to
 * whichever backend the background saw, and never asked that backend. A window
 * whose capabilities read from the previous operator resolved during a reset
 * armed {old relay, default backend}, which passed every entitlement check and
 * told the old operator's relay the npub was online every five minutes.
 *
 * No network: capabilities come from a stub `fetch`, relays from a stub
 * messaging provider. The npub is a fixed test value.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

const A = 'http://127.0.0.1:18701/api/v1';
const B = 'http://127.0.0.1:18702/api/v1';
const RELAY_A = 'ws://127.0.0.1:18711';
const RELAY_B = 'ws://127.0.0.1:18712';
const NPUB_HEX = 'ab'.repeat(32);

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

const local = new Map<string, unknown>();
const alarms: string[] = [];
const messageListeners: Listener[] = [];
(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    local: {
      get: async (key: string | string[]) => {
        const out: Record<string, unknown> = {};
        for (const k of Array.isArray(key) ? key : [key]) if (local.has(k)) out[k] = local.get(k);
        return out;
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) local.set(k, v);
      },
      remove: async (key: string | string[]) => {
        for (const k of Array.isArray(key) ? key : [key]) local.delete(k);
      },
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  alarms: {
    create: (name: string) => alarms.push(name),
    clear: () => undefined,
    onAlarm: { addListener: () => undefined },
  },
  runtime: {
    onMessage: { addListener: (l: Listener) => messageListeners.push(l) },
    getURL: (path: string) => path,
  },
};

const core = await import('@smirk/core');
const { installDmWatcher } = await import('../dm-watch');
const { PUBLIC_CACHE_KEY } = await import('../dapp/provider');

const relaysPolled: string[][] = [];
core.setMessagingProvider({
  kind: 'test',
  queryDmWraps: async ({ relays }: { relays: string[] }) => {
    relaysPolled.push([...relays]);
    return [];
  },
} as unknown as Parameters<typeof core.setMessagingProvider>[0]);

installDmWatcher();

/** The default backend (A) is selected and advertises RELAY_A. */
function walletOnA(t: TestContext): string[] {
  local.clear();
  alarms.length = 0;
  relaysPolled.length = 0;
  local.set(PUBLIC_CACHE_KEY, { fingerprint: 'fp-fixture', backendUrl: A });
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url === `${A}/capabilities`) {
      return new Response(
        JSON.stringify({ features: { nostr_relay: true }, messaging: { relay_url: RELAY_A } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return asked;
}

function arm(message: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    for (const listener of messageListeners) {
      if (listener({ type: 'DM_WATCH_SET', npubHex: NPUB_HEX, ...message }, {}, resolve as (r: unknown) => void)) return;
    }
    throw new Error('no listener took DM_WATCH_SET');
  });
}

test("a stale window's request for the previous operator's relay arms nothing", async (t) => {
  walletOnA(t);
  const reply = await arm({ relayUrl: RELAY_B, backendUrl: B });
  assert.equal(reply.ok, false);
  assert.ok(reply.error?.includes(B) && reply.error.includes(A), 'the refusal names both backends');
  assert.equal(local.has('dm.watch'), false, 'a watch was armed for a relay the backend never named');
  assert.deepEqual(alarms, []);
  assert.deepEqual(relaysPolled, [], 'the old relay was contacted');
});

test('a relay the selected backend does not advertise is refused', async (t) => {
  const asked = walletOnA(t);
  const reply = await arm({ relayUrl: RELAY_B, backendUrl: A });
  assert.equal(reply.ok, false);
  assert.ok(asked.includes(`${A}/capabilities`), "the backend's own advertisement was not checked");
  assert.equal(local.has('dm.watch'), false);
  assert.deepEqual(relaysPolled, []);
});

test("the backend's advertised relay is still watched", async (t) => {
  walletOnA(t);
  const reply = await arm({ relayUrl: RELAY_A, backendUrl: A });
  assert.equal(reply.ok, true);
  const watch = local.get('dm.watch') as { relayUrl: string; backendUrl: string };
  assert.equal(watch.relayUrl, RELAY_A);
  assert.equal(watch.backendUrl, A);
  assert.deepEqual(relaysPolled, [[RELAY_A]]);
});
