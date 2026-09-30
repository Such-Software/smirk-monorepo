import type { UnlockedWallet } from '@smirk/core';
import { storage, walletKeystore } from './singletons';
import {
  authorizeOperationWith, parseOperationPolicy,
  type OperationPolicy, type WalletOperation,
} from './operation-auth-policy';

export const OPERATION_POLICY_KEY = 'smirk.security.operation-password.v1';

export function assertOperationSession(wallet: UnlockedWallet): void {
  walletKeystore.assertUnlockedWallet(wallet);
}

export async function readOperationPolicy(): Promise<OperationPolicy> {
  return parseOperationPolicy(await storage.get(OPERATION_POLICY_KEY));
}

async function confirmPassword(wallet: UnlockedWallet, operation: WalletOperation, description: string, force = false) {
  await authorizeOperationWith({
    assertActive: assertOperationSession,
    readPolicy: readOperationPolicy,
    verifyPassword: (password, captured) => walletKeystore.verifyPassword(password, captured),
    prompt: async (message, verify) => {
      const { promptOperationPassword } = await import('./operation-password-dialog');
      return promptOperationPassword(message, verify);
    },
  }, operation, wallet, description, force);
}

export function authorizeOperation(operation: WalletOperation, wallet: UnlockedWallet, description: string): Promise<void> {
  return confirmPassword(wallet, operation, description);
}

/** Weakening an enabled confirmation policy also requires the wallet password. */
export async function writeOperationPolicy(
  key: keyof OperationPolicy,
  enabled: boolean,
  wallet: UnlockedWallet,
): Promise<OperationPolicy> {
  await confirmPassword(wallet, 'sign', 'Change password confirmation settings', true);
  const current = await readOperationPolicy();
  assertOperationSession(wallet);
  const policy = { ...current, [key]: enabled };
  await storage.set(OPERATION_POLICY_KEY, policy);
  assertOperationSession(wallet);
  return policy;
}
