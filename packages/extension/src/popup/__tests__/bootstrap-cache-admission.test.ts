import './_chrome-stub';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readBootstrapCache, writeBootstrapCache, clearBootstrapCache } from '../bootstrap-cache';
import { sessionStorage } from '../singletons';

beforeEach(clearBootstrapCache);

test('cached authentication preserves identity and heights but cannot replay new-wallet scan creation', async () => {
  const accessToken = crypto.randomUUID();
  await writeBootstrapCache('cache-fixture', accessToken, {
    userId: 'test-user', isNew: true, restoreState: 'new', xmrStartHeight: 123,
  }, Date.now() + 60_000);
  const cached = await readBootstrapCache('cache-fixture');
  assert.ok(cached?.accessToken === accessToken);
  assert.equal(cached?.bootstrap.userId, 'test-user');
  assert.equal(cached?.bootstrap.xmrStartHeight, 123);
  assert.equal(cached?.bootstrap.restoreState, undefined);
});

test('a previously written new-wallet cache entry also loses creation authority on read', async () => {
  await sessionStorage.set('smirk_bootstrap_cache_v1', {
    fingerprint: 'cache-fixture', accessToken: crypto.randomUUID(), cachedAt: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    bootstrap: { userId: 'test-user', isNew: true, restoreState: 'new' },
  });
  const cached = await readBootstrapCache('cache-fixture');
  assert.ok(cached);
  assert.equal(cached.bootstrap.restoreState, undefined);
});

test('existing-wallet evidence and explicit zero height survive cache projection', async () => {
  await writeBootstrapCache('cache-fixture', crypto.randomUUID(), {
    userId: 'test-user', isNew: false, restoreState: 'existing', wowStartHeight: 0,
  }, Date.now() + 60_000);
  const cached = await readBootstrapCache('cache-fixture');
  assert.equal(cached?.bootstrap.restoreState, 'existing');
  assert.equal(cached?.bootstrap.wowStartHeight, 0);
});
