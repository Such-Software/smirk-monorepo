/**
 * A website must not get a Smirk server proof signed through `signIn` or
 * `signMessage`.
 *
 * The legacy merge accepts `smirk-auth-rotate-v2|<api>|<sha256(new key)>|<ts>`
 * (`smirk-rotate-v1|...` on older servers), signed with a BTC key, as proof
 * that the row registered under that key may be folded into the account
 * holding the new key. The message is predictable, so a site that names ITS
 * OWN key as the new one and gets the user to approve a "sign in" could replay
 * the signature to `/auth/legacy-merge` and take the user's handle, npub and
 * tips. Only `smirk-auth-` was refused before; now every `smirk-` message is.
 *
 * These run the real executor every platform shares (the extension's approval
 * popup and the desktop BrowseTab) with a real unlocked wallet.
 */
import '../../popup/__tests__/_chrome-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bytesToHex,
  deriveAllKeys,
  deriveAddresses,
  rotationMessage,
  signBitcoinMessage,
  type UnlockedWallet,
} from '@smirk/core';
import type { ApprovalRequest } from '@such-software/smirk-dapp-api';
import type { ApprovalApproval } from '@smirk/ui';
import { executeApproval, type ExecuteApprovalDeps } from '../execute-approval';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const API = 'https://api.smirk.cash/api/v1';

function unlocked(): UnlockedWallet {
  const keys = deriveAllKeys(TEST_MNEMONIC, '', 3);
  return { keys, addresses: deriveAddresses(keys), fingerprint: 'fixture-wallet' } as UnlockedWallet;
}

const wallet = unlocked();
const deps = {
  wallet,
  async authorizeOperation() {},
  async ensureWasmInit() {},
  assertOperationSession() {},
} as unknown as ExecuteApprovalDeps;

const ORIGIN = { origin: 'https://attacker.example' };

/** The proof an attacker would want: rotation onto a key the attacker holds. */
function attackerRotation(): string {
  const attackerKey = bytesToHex(deriveAllKeys(TEST_MNEMONIC, 'attacker', 3).btc.publicKey);
  return rotationMessage(API, attackerKey, Math.floor(Date.now() / 1000));
}

function signInRequest(message: string): ApprovalRequest {
  return { kind: 'signIn', origin: ORIGIN, message, requestedAssets: ['btc'], alreadyConnected: false } as unknown as ApprovalRequest;
}

function signMessageRequest(message: string): ApprovalRequest {
  return { kind: 'signMessage', origin: ORIGIN, message, assets: ['btc', 'ltc', 'xmr'] } as unknown as ApprovalRequest;
}

const RESERVED = [
  attackerRotation(),
  `smirk-auth-${Math.floor(Date.now() / 1000)}`,
  `  SMIRK-ROTATE-v1|${API}|00|1`,
  'smirk-anything-the-server-adds-later',
];

for (const message of RESERVED) {
  test(`signIn refuses a reserved server proof: ${message.slice(0, 24)}`, async () => {
    await assert.rejects(
      executeApproval(signInRequest(message), { kind: 'signIn' } as ApprovalApproval, deps),
      /reserved/i,
    );
  });

  test(`signMessage refuses a reserved server proof: ${message.slice(0, 24)}`, async () => {
    await assert.rejects(
      executeApproval(signMessageRequest(message), { kind: 'signMessage' } as ApprovalApproval, deps),
      /reserved/i,
    );
  });
}

test('an ordinary sign-in challenge still signs, with the real BTC key', async () => {
  // The smirk.cash website's own challenge shape, which is outside the namespace.
  const message = 'Smirk Authentication Challenge\nNonce: 00\nOrigin: https://smirk.cash\nTimestamp: 1';
  const out = await executeApproval(signInRequest(message), { kind: 'signIn' } as ApprovalApproval, deps);
  assert.equal(out.kind, 'signIn');
  const sig = out.kind === 'signIn' && out.approved ? out.result.signatures.find((s) => s.asset === 'btc') : undefined;
  assert.ok(sig, 'a BTC signature is returned');
  assert.equal(sig.signature, signBitcoinMessage(message, wallet.keys.btc.privateKey));
});
