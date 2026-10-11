/**
 * Every JS context follows the durable backend selection, including a reset.
 *
 * "Reset to the default backend" removes the stored selection rather than
 * writing the default into it. The subscription used to act only on a written
 * config, so a reset left the background worker (and any second wallet window)
 * on the operator the user had just left: its next background sign-in sent the
 * wallet's keys there and handed the popup a token minted by that operator.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryStorage, type PlatformStorage } from '../../state/platform';
import {
  BACKEND_CONFIG_KEY,
  applyBackendConfig,
  subscribeBackend,
  writeBackendConfig,
  type BackendSelection,
} from '../backend-config';
import { api } from '../index';

const DEFAULT = { url: 'http://127.0.0.1:18701/api/v1', apiStyle: 'namespaced' as const };
const OTHER = { url: 'http://127.0.0.1:18702/api/v1', apiStyle: 'namespaced' as const };

/** Let the subscription's async storage read settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function follow(t: TestContext, storage: PlatformStorage): BackendSelection[] {
  const changes: BackendSelection[] = [];
  const unsubscribe = subscribeBackend(storage, DEFAULT, (selection) => changes.push(selection));
  t.after(unsubscribe);
  return changes;
}

test('a context on another operator returns to the default when the selection is reset elsewhere', async (t) => {
  const storage = new InMemoryStorage();
  applyBackendConfig(DEFAULT);
  const changes = follow(t, storage);

  await writeBackendConfig(storage, { ...OTHER, chosenAt: Date.now() });
  await settle();
  assert.equal(api.getBaseUrl(), OTHER.url, 'the context did not follow a switch made elsewhere');
  api.setAccessToken(crypto.randomUUID());

  await storage.remove(BACKEND_CONFIG_KEY);
  await settle();
  assert.equal(api.getBaseUrl(), DEFAULT.url, 'a reset elsewhere left this context on the previous operator');
  assert.equal(api.getAccessToken(), null, 'a token minted by the previous operator survived the reset');
  assert.equal(changes.at(-1)?.stored, false);
});

test('the context that made the change keeps the session it has already started', async (t) => {
  const storage = new InMemoryStorage();
  await writeBackendConfig(storage, { ...OTHER, chosenAt: Date.now() });
  applyBackendConfig(OTHER);
  const changes = follow(t, storage);

  // The switching window re-points itself, then signs in, before the change
  // notification for its own write arrives.
  applyBackendConfig(DEFAULT);
  const fresh = crypto.randomUUID();
  api.setAccessToken(fresh);
  await storage.remove(BACKEND_CONFIG_KEY);
  await settle();

  assert.equal(api.getBaseUrl(), DEFAULT.url);
  assert.equal(api.getAccessToken(), fresh, 'its own change notification signed the switching window out');
  assert.equal(changes.length, 0);
});

test('a context that cannot read the selection after a change stops authenticating', async (t) => {
  const inner = new InMemoryStorage();
  const storage: PlatformStorage = {
    get: async () => {
      throw new Error('storage unavailable');
    },
    set: (key, value) => inner.set(key, value),
    remove: (key) => inner.remove(key),
    subscribe: (listener) => inner.subscribe(listener),
  };
  applyBackendConfig(OTHER);
  api.setAccessToken(crypto.randomUUID());
  const warn = t.mock.method(console, 'warn', () => undefined);
  follow(t, storage);

  await storage.remove(BACKEND_CONFIG_KEY);
  await settle();
  assert.equal(api.getAccessToken(), null);
  assert.ok(warn.mock.callCount() > 0, 'the failure was not reported');
});
