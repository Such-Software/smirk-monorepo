import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireRestoreState, registeredRestoreState } from '../restore-state';

const params = { fingerprint: 'test-fingerprint', keys: [] };

test('registration must retain wallet history before onboarding can cache scan authority', async () => {
  await assert.rejects(registeredRestoreState({ checkRestore: async () => ({ data: { exists: false } }) },
    params, { exists: false }), /did not retain/);
  await assert.rejects(registeredRestoreState({ checkRestore: async () => ({ error: 'unavailable' }) },
    params, { exists: false }), /unavailable/);
  const saved = { exists: true, keysValid: true, xmrStartHeight: 0, wowStartHeight: 200 };
  assert.deepEqual(await registeredRestoreState({ checkRestore: async () => ({ data: saved }) }, params,
    { exists: false }), saved);
  assert.deepEqual(await registeredRestoreState({ checkRestore: async () => { throw new Error('unnecessary lookup'); } }, params,
    saved), saved);
});

test('unknown restore evidence refuses instead of selecting a new birthday', async () => {
  for (const reply of [
    { error: 'rate limit reached', status: 429 },
    { error: 'upstream unavailable', status: 503 },
    { data: {} },
    { data: { exists: null } },
    { data: { exists: 'false' } },
    { data: { exists: true, keysValid: false } },
    { data: { exists: true } },
    { data: { exists: true, keysValid: null } },
    { data: { exists: true, keysValid: 'true' } },
    { data: { exists: true, keysValid: 'false' } },
    { data: { exists: true, error: 'key mismatch' } },
    { data: { exists: true, keysValid: true, xmrStartHeight: -1 } },
    { data: { exists: true, keysValid: true, wowStartHeight: 1.5 } },
  ]) {
    await assert.rejects(requireRestoreState({ checkRestore: async () => reply } as never, params));
  }
  await assert.rejects(requireRestoreState({ checkRestore: async () => { throw new Error('connection reset'); } }, params), /connection reset/);
});

test('explicit new and existing wallets retain their distinct restore state', async () => {
  for (const data of [{ exists: false }, { exists: true, keysValid: true, xmrStartHeight: 0, wowStartHeight: 700_000 }]) {
    assert.deepEqual(await requireRestoreState({ checkRestore: async () => ({ data }) }, params), data);
  }
});
