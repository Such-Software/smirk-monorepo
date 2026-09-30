import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireRestoreState } from '../restore-state';

const params = { fingerprint: 'test-fingerprint', keys: [] };

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
