import '../../popup/__tests__/_chrome-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UnlockedWallet } from '@smirk/core';
import type { ApprovalRequest } from '@such-software/smirk-dapp-api';
import type { ApprovalApproval } from '@smirk/ui';
import { executeApproval, type ExecuteApprovalDeps } from '../execute-approval';

for (const kind of ['signMessage', 'signNostrEvent', 'appEncKey', 'appSealOpen', 'nostrCrypt'] as const) {
  test(`${kind} cannot execute when operation authorization is canceled`, async () => {
    let requested: string | undefined;
    let initialized = false;
    const deps = {
      wallet: { fingerprint: 'fixture-wallet' } as UnlockedWallet,
      async authorizeOperation(operation: string) {
        requested = operation;
        throw new Error('Password confirmation canceled');
      },
      async ensureWasmInit() { initialized = true; },
      assertOperationSession() {},
    } as unknown as ExecuteApprovalDeps;
    const request = { kind, origin: { origin: 'https://example.test' }, sessionCovered: true, firstGrant: false } as unknown as ApprovalRequest;
    await assert.rejects(executeApproval(request, { kind } as ApprovalApproval, deps), /canceled/);
    assert.equal(requested, 'sign');
    assert.equal(initialized, false, 'canceled authorization must stop before private-key work');
  });
}

test('a money-tier Nostr signature uses the send policy without a second prompt', async () => {
  const operations: string[] = [];
  const deps = {
    wallet: { fingerprint: 'fixture-wallet' } as UnlockedWallet,
    async authorizeOperation(operation: string) { operations.push(operation); throw new Error('Canceled'); },
  } as unknown as ExecuteApprovalDeps;
  const request = { kind: 'signNostrEvent', tier: 'money', origin: { origin: 'https://example.test' } } as ApprovalRequest;
  await assert.rejects(executeApproval(request, { kind: 'signNostrEvent' }, deps), /Canceled/);
  assert.deepEqual(operations, ['send']);
});
