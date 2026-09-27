import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '@smirk/core';
import { bootstrapAuthHandler } from '../bootstrap-auth';

test('background registration stops on failed history lookup before PoW and registration', async (t) => {
  t.mock.method(api, 'checkRestore', async () => ({ status: 429, error: 'restore lookup rate limited' }));
  let registered = false;
  let solved = false;
  t.mock.method(api, 'extensionRegister', async () => { registered = true; return { error: 'unexpected registration' }; });
  t.mock.method(api, 'powChallenge', async () => { solved = true; return { error: 'unexpected proof of work' }; });
  await assert.rejects(bootstrapAuthHandler.run({
    fingerprint: 'test-fingerprint', keys: [], signedTimestamp: 0, signature: 'not-used',
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
    fingerprint: 'test-fingerprint', keys: [], signedTimestamp: 0, signature: 'not-used',
  }, { signal: new AbortController().signal } as never));
  assert.equal(registered, false);
  assert.equal(solved, false);
});
