/**
 * Tests for session-state, route, wizards. Uses InMemoryStorage as the
 * backend so tests are platform-independent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_VERSION,
  DEFAULT_SESSION_STATE,
  InMemoryStorage,
  MIGRATIONS,
  SessionStateStore,
  RouteController,
  Wizard,
  migrate,
  tabOf,
} from '../index';

// =========================================================================
// SessionStateStore
// =========================================================================

test('store returns defaults on first load', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  const state = await store.load();
  assert.deepEqual(state, DEFAULT_SESSION_STATE);
  store.destroy();
});

test('store persists writes across instances backed by same storage', async () => {
  const storage = new InMemoryStorage();
  const a = new SessionStateStore(storage);
  await a.update((s) => {
    s.route = { current: 'swap' };
  });
  a.destroy();

  const b = new SessionStateStore(storage);
  const state = await b.load();
  assert.equal(state.route.current, 'swap');
  b.destroy();
});

test('store update mutator can mutate draft directly', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  const next = await store.update((s) => {
    s.ui.balanceHidden = true;
    s.ui.denomination = 'BTC';
  });
  assert.equal(next.ui.balanceHidden, true);
  assert.equal(next.ui.denomination, 'BTC');
  store.destroy();
});

test('store subscribers fire on update', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  let received = 0;
  const unsub = store.subscribe(() => {
    received += 1;
  });

  await store.update((s) => {
    s.route = { current: 'inbox' };
  });
  await store.update((s) => {
    s.route = { current: 'home' };
  });

  assert.equal(received, 2);
  unsub();
  store.destroy();
});

test('store subscribers fire on cross-context writes (via shared storage)', async () => {
  const storage = new InMemoryStorage();
  const a = new SessionStateStore(storage);
  const b = new SessionStateStore(storage);

  // Event microtask handling needs an explicit yield — wait for the
  // subscriber callback before asserting.
  let bSeen: string | null = null;
  const seen = new Promise<string>((resolve) => {
    b.subscribe((state) => {
      if (state.route.current === 'swap') {
        bSeen = state.route.current;
        resolve(state.route.current);
      }
    });
  });

  await a.update((s) => {
    s.route = { current: 'swap' };
  });

  await seen;
  assert.equal(bSeen, 'swap');
  a.destroy();
  b.destroy();
});

test('store update is serialized — 50 concurrent updates all land', async () => {
  // Regression for 2026-06-13 Trocador swap audit. Pre-fix, two
  // concurrent `update()` calls each `load()`-ed the same cached
  // state, mutated independent JSON-deep-cloned drafts, and the
  // later `save()` clobbered the earlier write. The Trocador
  // "Open Send → pre-filled" handler hit this — its prefill write
  // raced with the trocador-wizard step write and the prefill
  // disappeared, sending the user to PICK A COIN instead of
  // Compose. The Promise-chain mutex in `update()` makes every
  // concurrent caller observe the previous write before its own
  // load.
  const store = new SessionStateStore(new InMemoryStorage());
  const N = 50;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      store.update((s) => {
        s.scroll[`row-${i}`] = i;
      }),
    ),
  );
  const final = await store.load();
  for (let i = 0; i < N; i++) {
    assert.equal(final.scroll[`row-${i}`], i, `row-${i} must survive concurrent writes`);
  }
  store.destroy();
});

test('store update mutator throw does not strand subsequent updates', async () => {
  // Belt-and-suspenders: if one queued mutator throws, the chain
  // must keep moving so the next caller still runs. Without the
  // `.catch(() => {})` rescue on `updateChain`, a single throw
  // would freeze the store for the rest of the session.
  const store = new SessionStateStore(new InMemoryStorage());
  const errors: unknown[] = [];
  await Promise.all([
    store.update(() => {
      throw new Error('boom');
    }).catch((e) => errors.push(e)),
    store.update((s) => {
      s.route = { current: 'inbox' };
    }),
  ]);
  assert.equal(errors.length, 1);
  const final = await store.load();
  assert.equal(final.route.current, 'inbox');
  store.destroy();
});

test('store reset returns to defaults', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  await store.update((s) => {
    s.route = { current: 'inbox' };
    s.ui.balanceHidden = true;
  });
  await store.reset();
  const state = await store.load();
  assert.deepEqual(state, DEFAULT_SESSION_STATE);
  store.destroy();
});

// =========================================================================
// Migrations
// =========================================================================

test('migrate: null/undefined raw -> defaults', () => {
  assert.deepEqual(migrate(null), DEFAULT_SESSION_STATE);
  assert.deepEqual(migrate(undefined), DEFAULT_SESSION_STATE);
});

test('migrate: state already at CURRENT_VERSION passes through (with default fill-in)', () => {
  const raw = { ...DEFAULT_SESSION_STATE };
  const migrated = migrate(raw);
  assert.equal(migrated.version, CURRENT_VERSION);
  assert.deepEqual(migrated.route, DEFAULT_SESSION_STATE.route);
});

test('migrate: state with missing fields gets defaults filled in', () => {
  const partial = { version: CURRENT_VERSION, route: { current: 'swap' } };
  const migrated = migrate(partial);
  assert.equal(migrated.version, CURRENT_VERSION);
  assert.equal(migrated.route.current, 'swap');
  assert.deepEqual(migrated.ui, DEFAULT_SESSION_STATE.ui);
  assert.deepEqual(migrated.scroll, {});
});

test('migrate: registered migration runs', () => {
  // Inject a fake migration: v0 → v1 adds a sentinel field.
  // (The real CURRENT_VERSION may be > 1 by the time more migrations land.)
  const originalMigration = MIGRATIONS[0];
  let ran = false;
  MIGRATIONS[0] = (s: any) => {
    ran = true;
    return { ...s, version: 1, route: { current: 'home' } };
  };
  try {
    migrate({ version: 0, foo: 'bar' });
    assert.equal(ran, true);
  } finally {
    if (originalMigration) MIGRATIONS[0] = originalMigration;
    else delete MIGRATIONS[0];
  }
});

test('migrate: missing migration falls back to defaults', () => {
  // version 999 — no migration path. Resets rather than corrupting state.
  const migrated = migrate({ version: 999, weirdField: true });
  assert.deepEqual(migrated, DEFAULT_SESSION_STATE);
});

// =========================================================================
// RouteController
// =========================================================================

test('router: navigate sets the current route', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  const router = new RouteController(store);

  await router.navigate('inbox');
  assert.equal((await router.get()).current, 'inbox');

  await router.navigate('home/asset/btc', { assetId: 'btc' });
  const r = await router.get();
  assert.equal(r.current, 'home/asset/btc');
  assert.deepEqual(r.params, { assetId: 'btc' });

  store.destroy();
});

test('router: back collapses one segment', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  const router = new RouteController(store);
  await router.navigate('home/asset/btc');
  await router.back();
  assert.equal((await router.get()).current, 'home/asset');
  await router.back();
  assert.equal((await router.get()).current, 'home');
  // Top-level: stays put.
  await router.back();
  assert.equal((await router.get()).current, 'home');
  store.destroy();
});

test('router: scroll save + restore', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  const router = new RouteController(store);
  await router.navigate('inbox');
  await router.saveScroll(420);
  assert.equal(await router.getScroll('inbox'), 420);
  // Different route → 0
  assert.equal(await router.getScroll('home'), 0);
  store.destroy();
});

test('tabOf: parses top-level segment', () => {
  assert.equal(tabOf({ current: 'home' }), 'home');
  assert.equal(tabOf({ current: 'home/asset/btc' }), 'home');
  assert.equal(tabOf({ current: 'inbox/item/abc123' }), 'inbox');
  assert.equal(tabOf({ current: 'swap' }), 'swap');
  assert.equal(tabOf({ current: 'settings/rpc/btc' }), 'settings');
  // Wizards default to home as conceptual parent.
  assert.equal(tabOf({ current: 'wizard/tip-maker' }), 'home');
});

// =========================================================================
// Wizard
// =========================================================================

interface TipFields extends Record<string, unknown> {
  assetId?: string;
  amount?: string;
  note?: string;
}

test('wizard: start initializes step 0 + default fields', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  const w = new Wizard<TipFields>(store, 'tip-maker', { assetId: 'btc' });
  await w.start();
  const snap = await w.snapshot();
  assert.notEqual(snap, null);
  assert.equal(snap!.step, 0);
  assert.equal(snap!.fields.assetId, 'btc');
  assert.ok(snap!.startedAt > 0);
  store.destroy();
});

test('wizard: start is idempotent — does not overwrite existing state', async () => {
  // Regression: SendWizard / TipMaker / etc. call `start()` from a
  // `useEffect([])` on mount. The first render sees `active=false`
  // because session-state load is async; without idempotency, that
  // mount-time call would overwrite the persisted state with a
  // fresh step-0 — losing wizard progress across popup close+reopen.
  const store = new SessionStateStore(new InMemoryStorage());
  const w = new Wizard<TipFields>(store, 'tip-maker', {});
  await w.start();
  await w.setField('amount', '0.005');
  await w.next();
  await w.setField('note', 'thanks!');
  const beforeRestart = await w.snapshot();
  assert.equal(beforeRestart!.step, 1);
  assert.equal(beforeRestart!.fields.amount, '0.005');
  assert.equal(beforeRestart!.fields.note, 'thanks!');

  // Second start() should be a no-op, NOT overwrite the user's state.
  await w.start();
  const afterRestart = await w.snapshot();
  assert.equal(afterRestart!.step, 1, 'step preserved');
  assert.equal(afterRestart!.fields.amount, '0.005', 'amount preserved');
  assert.equal(afterRestart!.fields.note, 'thanks!', 'note preserved');
  assert.equal(afterRestart!.startedAt, beforeRestart!.startedAt, 'startedAt preserved');

  // Explicit cancel + start IS the path for a fresh wizard.
  await w.cancel();
  await w.start();
  const fresh = await w.snapshot();
  assert.equal(fresh!.step, 0);
  assert.equal(fresh!.fields.amount, undefined);
  store.destroy();
});

test('wizard: setField + next + back', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  const w = new Wizard<TipFields>(store, 'tip-maker', {});
  await w.start();

  await w.setField('amount', '0.005');
  await w.next();
  await w.setField('note', 'thanks!');
  await w.next();

  const snap = await w.snapshot();
  assert.equal(snap!.step, 2);
  assert.equal(snap!.fields.amount, '0.005');
  assert.equal(snap!.fields.note, 'thanks!');

  await w.back();
  const snap2 = await w.snapshot();
  assert.equal(snap2!.step, 1);

  store.destroy();
});

test('wizard: state survives across store instances (popup close + reopen sim)', async () => {
  const storage = new InMemoryStorage();

  const a = new SessionStateStore(storage);
  const wA = new Wizard<TipFields>(a, 'tip-maker', {});
  await wA.start();
  await wA.setField('assetId', 'xmr');
  await wA.setField('amount', '1.5');
  await wA.next();
  a.destroy();

  // New store instance — same storage. Mimics popup close + reopen.
  const b = new SessionStateStore(storage);
  const wB = new Wizard<TipFields>(b, 'tip-maker', {});
  const snap = await wB.snapshot();
  assert.notEqual(snap, null);
  assert.equal(snap!.step, 1);
  assert.equal(snap!.fields.assetId, 'xmr');
  assert.equal(snap!.fields.amount, '1.5');
  b.destroy();
});

test('wizard: cancel removes state', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  const w = new Wizard<TipFields>(store, 'tip-maker', {});
  await w.start();
  await w.setField('assetId', 'btc');
  assert.equal(await w.isActive(), true);
  await w.cancel();
  assert.equal(await w.isActive(), false);
  assert.equal(await w.snapshot(), null);
  store.destroy();
});

test('wizard: patchFields merges', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  const w = new Wizard<TipFields>(store, 'tip-maker', { assetId: 'btc' });
  await w.start();
  await w.patchFields({ amount: '0.01', note: 'hi' });
  const snap = await w.snapshot();
  assert.equal(snap!.fields.assetId, 'btc');
  assert.equal(snap!.fields.amount, '0.01');
  assert.equal(snap!.fields.note, 'hi');
  store.destroy();
});

test('wizard: goToStep validates non-negative', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  const w = new Wizard<TipFields>(store, 'tip-maker', {});
  await w.start();
  await assert.rejects(() => w.goToStep(-1));
  store.destroy();
});

test('wizard: two wizards with different ids are independent', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  const tip = new Wizard<TipFields>(store, 'tip', {});
  const send = new Wizard<TipFields>(store, 'send', {});

  await tip.start();
  await tip.setField('assetId', 'btc');
  await tip.next();

  await send.start();
  await send.setField('assetId', 'xmr');

  const tipSnap = await tip.snapshot();
  const sendSnap = await send.snapshot();
  assert.equal(tipSnap!.fields.assetId, 'btc');
  assert.equal(tipSnap!.step, 1);
  assert.equal(sendSnap!.fields.assetId, 'xmr');
  assert.equal(sendSnap!.step, 0);

  store.destroy();
});
