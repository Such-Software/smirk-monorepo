/**
 * What a relaunched wallet reopens: drafts and in-flight operations resume,
 * finished flows give way to Home.
 *
 * Before this, a relaunch restored whatever route and wizard step were stored,
 * so a wallet closed on a result screen reopened on that result (or on its
 * flow's first step, emptied), as if the operation were still to do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SESSION_STATE,
  FINISHED_ROUTE_PARAM,
  InMemoryStorage,
  RouteController,
  SessionStateStore,
  routeIsFinished,
  routeWithin,
  settleForLaunch,
  stateForLaunch,
  type FinishedFlowRule,
  type PlatformStorage,
  type SessionState,
  type WizardState,
} from '../index';

/** A demo flow whose result screen is step 2 or later. */
const DEMO: FinishedFlowRule = { wizardId: 'demo', routes: ['home/demo'], finished: (w) => w.step >= 2 };
/** A second flow sharing a route, like the Swap tab's providers. */
const SHARED_A: FinishedFlowRule = { wizardId: 'a', routes: ['swap'], finished: (w) => w.fields.done === true };
const SHARED_B: FinishedFlowRule = { wizardId: 'b', routes: ['swap'], finished: (w) => w.fields.done === true };
const RULES = [DEMO, SHARED_A, SHARED_B];

function wizard(step: number, fields: Record<string, unknown> = {}): WizardState {
  return { step, fields, startedAt: 1 };
}

function session(route: SessionState['route'], wizards: Record<string, WizardState>): SessionState {
  return { ...DEFAULT_SESSION_STATE, route, wizards };
}

test('a draft still in progress is restored untouched', () => {
  const before = session({ current: 'home/demo' }, { demo: wizard(1, { amount: '1' }) });
  assert.equal(stateForLaunch(before, RULES), before);
});

test('a finished flow on screen gives way to Home and its state is dropped', () => {
  const after = stateForLaunch(session({ current: 'home/demo' }, { demo: wizard(2) }), RULES);
  assert.equal(after.route.current, 'home');
  assert.equal('demo' in after.wizards, false);
});

test('a finished flow under a drill-down of its route also gives way to Home', () => {
  const after = stateForLaunch(session({ current: 'home/demo/asset/btc' }, { demo: wizard(3) }), RULES);
  assert.equal(after.route.current, 'home');
});

test('a route that only shares a prefix is not the flow route', () => {
  assert.equal(routeWithin('home/demo/asset/btc', ['home/demo']), true);
  assert.equal(routeWithin('home/demonstration', ['home/demo']), false);
  const before = session({ current: 'home/demonstration' }, {});
  assert.equal(stateForLaunch(before, RULES).route.current, 'home/demonstration');
});

test('a finished flow off screen is dropped without moving the user', () => {
  const after = stateForLaunch(
    session({ current: 'settings/backend' }, { demo: wizard(2), other: wizard(1) }),
    RULES,
  );
  assert.equal(after.route.current, 'settings/backend');
  assert.equal('demo' in after.wizards, false);
  // A wizard no rule covers is never touched.
  assert.deepEqual(after.wizards.other, wizard(1));
});

test('a route keeps its place while another flow it hosts is still active', () => {
  const after = stateForLaunch(
    session({ current: 'swap' }, { a: wizard(3, { done: true }), b: wizard(2, { done: false }) }),
    RULES,
  );
  assert.equal(after.route.current, 'swap');
  assert.equal('a' in after.wizards, false);
  assert.deepEqual(after.wizards.b, wizard(2, { done: false }));
});

test('a route marked finished by its result screen gives way to Home', () => {
  const marked = session({ current: 'home/tip/btc', params: { [FINISHED_ROUTE_PARAM]: true } }, { demo: wizard(1) });
  assert.equal(routeIsFinished(marked.route), true);
  const after = stateForLaunch(marked, RULES);
  assert.equal(after.route.current, 'home');
  assert.equal(routeIsFinished(after.route), false);
  // Marking a route never drops an unrelated draft.
  assert.deepEqual(after.wizards.demo, wizard(1));
});

test('state a rule cannot read is kept rather than dropped', () => {
  const throwing: FinishedFlowRule = {
    wizardId: 'demo',
    routes: ['home/demo'],
    finished: () => {
      throw new TypeError('fields from an older build');
    },
  };
  const before = session({ current: 'home/demo' }, { demo: wizard(9) });
  assert.equal(stateForLaunch(before, [throwing]), before);
});

test('markFinished marks only the route it names, and navigating clears the mark', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  const router = new RouteController(store);
  await router.navigate('home/tip');
  await router.markFinished('home/send');
  assert.equal(routeIsFinished(await router.get()), false, 'a result for a route the user left marks nothing');
  await router.markFinished('home/tip');
  assert.equal(routeIsFinished(await router.get()), true);
  assert.equal((await router.get()).current, 'home/tip');
  await router.navigate('home');
  await router.navigate('home/tip');
  assert.equal(routeIsFinished(await router.get()), false);
  store.destroy();
});

test('relaunch after closing on a result opens Home; relaunch mid-draft resumes it', async () => {
  const storage = new InMemoryStorage();
  const first = new SessionStateStore(storage);
  await new RouteController(first).navigate('home/demo');
  await first.update((s) => {
    s.wizards.demo = wizard(2);
  });
  first.destroy();

  const second = new SessionStateStore(storage);
  await settleForLaunch(second, RULES);
  second.destroy();
  const third = new SessionStateStore(storage);
  const reopened = await third.load();
  assert.equal(reopened.route.current, 'home');
  assert.equal('demo' in reopened.wizards, false);

  await new RouteController(third).navigate('home/demo');
  await third.update((s) => {
    s.wizards.demo = wizard(1, { amount: '2' });
  });
  third.destroy();
  const fourth = new SessionStateStore(storage);
  await settleForLaunch(fourth, RULES);
  const resumed = await fourth.load();
  assert.equal(resumed.route.current, 'home/demo');
  assert.deepEqual(resumed.wizards.demo, wizard(1, { amount: '2' }));
  fourth.destroy();
});

/** Storage whose next reads answer late, with the value they saw when issued. */
class LateReads implements PlatformStorage {
  readonly inner = new InMemoryStorage();
  late = 0;
  async get<T>(key: string): Promise<T | null> {
    const seen = await this.inner.get<T>(key);
    const copy = seen === null ? null : (JSON.parse(JSON.stringify(seen)) as T);
    if (this.late > 0) {
      this.late -= 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return copy;
  }
  set<T>(key: string, value: T): Promise<void> {
    return this.inner.set(key, value);
  }
  remove(key: string): Promise<void> {
    return this.inner.remove(key);
  }
  subscribe(listener: (key: string) => void): () => void {
    return this.inner.subscribe(listener);
  }
}

test('a launch write survives a first read that answers after it', async () => {
  // Found by relaunching a built popup: the settle wrote Home, then a read
  // issued before it answered late, replaced the cache with the old route, and
  // the next update saved that back.
  const storage = new LateReads();
  await storage.inner.set('k', session({ current: 'home/demo' }, { demo: wizard(2) }));
  const store = new SessionStateStore(storage, 'k');
  storage.late = 1;
  const earlyRead = store.load();
  await settleForLaunch(store, RULES);
  await earlyRead;
  await store.update(() => undefined);
  const stored = await storage.inner.get<SessionState>('k');
  assert.equal(stored?.route.current, 'home');
  assert.equal(stored && 'demo' in stored.wizards, false);
  store.destroy();
});

test('state written while the first read is in flight is not replaced by that read', async () => {
  const storage = new LateReads();
  await storage.inner.set('k', session({ current: 'home/demo' }, { demo: wizard(1) }));
  const store = new SessionStateStore(storage, 'k');
  storage.late = 1;
  const earlyRead = store.load();
  await store.save(session({ current: 'settings' }, {}));
  await earlyRead;
  assert.equal((await store.load()).route.current, 'settings');
  store.destroy();
});

test('an ordinary launch writes nothing, so other open windows are not woken', async () => {
  const store = new SessionStateStore(new InMemoryStorage());
  await store.update((s) => {
    s.route = { current: 'home/demo' };
    s.wizards.demo = wizard(1);
  });
  let writes = 0;
  const unsub = store.subscribe(() => {
    writes += 1;
  });
  await settleForLaunch(store, RULES);
  assert.equal(writes, 0);
  unsub();
  store.destroy();
});
