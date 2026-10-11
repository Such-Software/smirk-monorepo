import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '@smirk/core';
import { bootstrapAuthHandler } from '../bootstrap-auth';
import { signInClients } from '../sign-in-client';

// These tests stub the sign-in's requests on the shared `api` singleton, so the
// handler's per-job client is that singleton here. Which backend the requests
// reach is covered by backend-binding.test.ts.
mock.method(signInClients, 'for', () => api);

/** The backend this context points at: the one a job may sign in to. */
const here = () => ({ url: api.getBaseUrl(), apiStyle: api.getWalletApiStyle() });

test('background registration stops on failed history lookup before PoW and registration', async (t) => {
  t.mock.method(api, 'checkRestore', async () => ({ status: 429, error: 'restore lookup rate limited' }));
  let registered = false;
  let solved = false;
  t.mock.method(api, 'extensionRegister', async () => { registered = true; return { error: 'unexpected registration' }; });
  t.mock.method(api, 'powChallenge', async () => { solved = true; return { error: 'unexpected proof of work' }; });
  await assert.rejects(bootstrapAuthHandler.run({
    backend: here(), fingerprint: 'test-fingerprint', keys: [], signedTimestamp: 0, signature: 'not-used',
  }, { signal: new AbortController().signal } as never), /rate limited/);
  assert.equal(registered, false);
  assert.equal(solved, false);
});

test('existing wallet key mismatch cannot become a registration or new birthday', async (t) => {
  t.mock.method(api, 'checkRestore', async () => ({ data: {
    exists: true, keysValid: false, xmrStartHeight: 100, wowStartHeight: 200,
  } }));
  let registered = false;
  let solved = false;
  t.mock.method(api, 'extensionRegister', async () => { registered = true; return { error: 'unexpected registration' }; });
  t.mock.method(api, 'powChallenge', async () => { solved = true; return { error: 'unexpected proof of work' }; });
  await assert.rejects(bootstrapAuthHandler.run({
    backend: here(), fingerprint: 'test-fingerprint', keys: [], signedTimestamp: 0, signature: 'not-used',
  }, { signal: new AbortController().signal } as never));
  assert.equal(registered, false);
  assert.equal(solved, false);
});
