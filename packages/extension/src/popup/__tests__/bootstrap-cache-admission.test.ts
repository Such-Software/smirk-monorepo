import './_chrome-stub';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readBootstrapCache, writeBootstrapCache, clearBootstrapCache } from '../bootstrap-cache';
import { sessionStorage } from '../singletons';

const A = 'http://127.0.0.1:18701/api/v1';
const B = 'http://127.0.0.1:18702/api/v1';

beforeEach(clearBootstrapCache);

test('cached authentication preserves identity and heights but cannot replay new-wallet scan creation', async () => {
  const accessToken = crypto.randomUUID();
  await writeBootstrapCache({
    fingerprint: 'cache-fixture',
    backendUrl: A,
    accessToken,
    bootstrap: { userId: 'test-user', isNew: true, restoreState: 'new', xmrStartHeight: 123 },
    sessionExpiresAtMs: Date.now() + 60_000,
  });
  const cached = await readBootstrapCache('cache-fixture', A);
  assert.ok(cached?.accessToken === accessToken);
  assert.equal(cached?.bootstrap.userId, 'test-user');
  assert.equal(cached?.bootstrap.xmrStartHeight, 123);
  assert.equal(cached?.bootstrap.restoreState, undefined);
});

test('a previously written new-wallet cache entry also loses creation authority on read', async () => {
  await sessionStorage.set('smirk_bootstrap_cache_v1', {
    fingerprint: 'cache-fixture', backendUrl: A, accessToken: crypto.randomUUID(), cachedAt: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    bootstrap: { userId: 'test-user', isNew: true, restoreState: 'new' },
  });
  const cached = await readBootstrapCache('cache-fixture', A);
  assert.ok(cached);
  assert.equal(cached.bootstrap.restoreState, undefined);
});

test('existing-wallet evidence and explicit zero height survive cache projection', async () => {
  await writeBootstrapCache({
    fingerprint: 'cache-fixture',
    backendUrl: A,
    accessToken: crypto.randomUUID(),
    bootstrap: { userId: 'test-user', isNew: false, restoreState: 'existing', wowStartHeight: 0 },
    sessionExpiresAtMs: Date.now() + 60_000,
  });
  const cached = await readBootstrapCache('cache-fixture', A);
  assert.equal(cached?.bootstrap.restoreState, 'existing');
  assert.equal(cached?.bootstrap.wowStartHeight, 0);
});

// A token is valid only at the backend that minted it. Keyed by wallet alone,
// a cached sign-in from one backend was installed for whichever backend the
// next warm open pointed at, and presented there on every call.
test('a cached sign-in is never handed to another backend', async () => {
  await writeBootstrapCache({
    fingerprint: 'cache-fixture',
    backendUrl: A,
    accessToken: crypto.randomUUID(),
    bootstrap: { userId: 'user-at-a', isNew: false },
    sessionExpiresAtMs: Date.now() + 60_000,
  });
  assert.equal(await readBootstrapCache('cache-fixture', B), null);
  assert.ok(await readBootstrapCache('cache-fixture', A));
});

test('an entry that names no backend is not trusted for any', async () => {
  await sessionStorage.set('smirk_bootstrap_cache_v1', {
    fingerprint: 'cache-fixture', accessToken: crypto.randomUUID(), cachedAt: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    bootstrap: { userId: 'test-user', isNew: false },
  });
  assert.equal(await readBootstrapCache('cache-fixture', A), null);
});
