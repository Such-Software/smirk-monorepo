/**
 * The NIP-98 self-auth guard protects every backend the wallet holds an
 * account at, not only the one selected now.
 *
 * Review of #46: the guard refused only the selected backend's host. The
 * account-0 npub is the same at every backend, so after any switch, in either
 * direction, a connected site granted account-0 could have the user sign a
 * kind-27235 event for the previous backend's `/auth/nostr` and mint a full
 * session there.
 *
 * Fixture: the standard BIP39 test vector phrase, never a real wallet.
 */
import '../../popup/__tests__/_chrome-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { api, deriveAllKeys, deriveNostrIdentity, type UnlockedWallet } from '@smirk/core';
import type { ApprovalRequest } from '@such-software/smirk-dapp-api';
import type { ApprovalApproval } from '@smirk/ui';

import { signNostrEventWith } from '../signers';
import { executeApproval, type ExecuteApprovalDeps } from '../execute-approval';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SELECTED = 'https://api.smirk.cash/api/v1';
const LEFT = 'https://other-operator.example/api/v1';

api.setBaseUrl(SELECTED);

const identity = deriveNostrIdentity(TEST_MNEMONIC, 0);

function signInTokenFor(backend: string) {
  return {
    kind: 27235,
    tags: [
      ['u', `${backend}/auth/nostr`],
      ['method', 'POST'],
    ],
    content: '',
    created_at: Math.floor(Date.now() / 1000),
  };
}

test('refuses a sign-in token for a backend the wallet has left', () => {
  assert.throws(
    () => signNostrEventWith(identity, signInTokenFor(LEFT), [LEFT]),
    /sign-in token/i,
  );
});

test('still refuses the selected backend, and still signs for a third party', () => {
  assert.throws(() => signNostrEventWith(identity, signInTokenFor(SELECTED), [LEFT]), /sign-in token/i);
  const signed = signNostrEventWith(
    identity,
    { ...signInTokenFor('https://someone-else.example/api'), kind: 27235 },
    [LEFT],
  );
  assert.ok(signed.sig);
});

test('a site approval cannot get a sign-in token for a remembered backend', async () => {
  const keys = deriveAllKeys(TEST_MNEMONIC, '', 3);
  const wallet = { keys, mnemonic: TEST_MNEMONIC, fingerprint: 'fixture-wallet' } as unknown as UnlockedWallet;
  let asked = 0;
  const deps = {
    wallet,
    async authorizeOperation() {},
    async ensureWasmInit() {},
    assertOperationSession() {},
    async knownBackends() {
      asked += 1;
      return [LEFT];
    },
  } as unknown as ExecuteApprovalDeps;
  const request = {
    kind: 'signNostrEvent',
    tier: 'money',
    origin: { origin: 'https://attacker.example' },
    event: signInTokenFor(LEFT),
  } as unknown as ApprovalRequest;

  await assert.rejects(
    executeApproval(request, { kind: 'signNostrEvent' } as ApprovalApproval, deps),
    /sign-in token/i,
  );
  assert.equal(asked, 1, 'the approval never asked which backends to protect');
});
