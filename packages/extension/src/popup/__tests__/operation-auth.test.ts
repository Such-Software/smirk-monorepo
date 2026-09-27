import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UnlockedWallet } from '@smirk/core';
import {
  authorizeOperationWith, DEFAULT_OPERATION_POLICY, parseOperationPolicy,
  requiresOperationPassword, type OperationAuthDeps, type OperationPolicy,
} from '../operation-auth-policy';

const wallet = { fingerprint: 'test-wallet', sessionExpiresAtMs: 5000 } as UnlockedWallet;

function fixture(policy: OperationPolicy = DEFAULT_OPERATION_POLICY) {
  let active = true;
  let prompts = 0;
  let passwordChecks = 0;
  const deps: OperationAuthDeps = {
    assertActive(captured) {
      assert.equal(captured, wallet);
      if (!active) throw new Error('Wallet is locked');
    },
    async readPolicy() { return policy; },
    async verifyPassword(password, captured) {
      assert.equal(captured, wallet);
      passwordChecks += 1;
      if (password !== 'fixture-password') throw new Error('Invalid password');
    },
    async prompt(_description, verify) { prompts += 1; await verify('fixture-password'); },
  };
  return { deps, lock: () => { active = false; }, counts: () => ({ prompts, passwordChecks }) };
}

test('both confirmation preferences default off', async () => {
  assert.deepEqual(parseOperationPolicy(undefined), DEFAULT_OPERATION_POLICY);
  const f = fixture();
  await authorizeOperationWith(f.deps, 'send', wallet, 'Send');
  await authorizeOperationWith(f.deps, 'sign', wallet, 'Sign');
  assert.deepEqual(f.counts(), { prompts: 0, passwordChecks: 0 });
});

test('send confirmation and general signing confirmation have independent scope', () => {
  const sends = { requirePasswordForSends: true, requirePasswordForSigning: false };
  assert.equal(requiresOperationPassword(sends, 'send'), true);
  assert.equal(requiresOperationPassword(sends, 'sign'), false);
  const signing = { requirePasswordForSends: false, requirePasswordForSigning: true };
  assert.equal(requiresOperationPassword(signing, 'send'), true);
  assert.equal(requiresOperationPassword(signing, 'sign'), true);
});

test('each operation verifies a password once and leaves the grace deadline unchanged', async () => {
  const f = fixture({ requirePasswordForSends: true, requirePasswordForSigning: true });
  const expiry = wallet.sessionExpiresAtMs;
  await authorizeOperationWith(f.deps, 'send', wallet, 'First send');
  await authorizeOperationWith(f.deps, 'send', wallet, 'Second send');
  assert.deepEqual(f.counts(), { prompts: 2, passwordChecks: 2 });
  assert.equal(wallet.sessionExpiresAtMs, expiry);
});

test('changing confirmation preferences verifies even while both flags are off', async () => {
  const f = fixture();
  await authorizeOperationWith(f.deps, 'sign', wallet, 'Change settings', true);
  assert.equal(f.counts().passwordChecks, 1);
});

test('missing confirmation, cancellation, and wrong passwords cannot authorize', async () => {
  for (const prompt of [
    async () => {},
    async () => { throw new Error('Canceled'); },
    async (_: string, verify: (password: string) => Promise<void>) => { await verify('wrong'); },
  ]) {
    const f = fixture({ requirePasswordForSends: true, requirePasswordForSigning: false });
    f.deps.prompt = prompt;
    await assert.rejects(authorizeOperationWith(f.deps, 'send', wallet, 'Send'));
  }
});

test('a lock during policy read, prompt, or password derivation cancels the operation', async () => {
  for (const phase of ['policy', 'prompt', 'verification']) {
    const f = fixture({ requirePasswordForSends: true, requirePasswordForSigning: true });
    if (phase === 'policy') f.deps.readPolicy = async () => { f.lock(); return DEFAULT_OPERATION_POLICY; };
    if (phase === 'prompt') f.deps.prompt = async (_, verify) => { f.lock(); await verify('fixture-password'); };
    if (phase === 'verification') f.deps.verifyPassword = async () => { f.lock(); };
    await assert.rejects(authorizeOperationWith(f.deps, 'send', wallet, 'Send'), /locked/);
  }
});

test('unreadable or malformed policy never becomes an unprotected operation', async () => {
  assert.throws(() => parseOperationPolicy({ requirePasswordForSends: 'false' }), /settings/);
  const f = fixture();
  f.deps.readPolicy = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(authorizeOperationWith(f.deps, 'send', wallet, 'Send'), /storage unavailable/);
});
