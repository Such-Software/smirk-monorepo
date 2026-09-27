import type { UnlockedWallet } from '@smirk/core';

export type WalletOperation = 'send' | 'sign';
export interface OperationPolicy {
  requirePasswordForSends: boolean;
  requirePasswordForSigning: boolean;
}
export const DEFAULT_OPERATION_POLICY: OperationPolicy = {
  requirePasswordForSends: false,
  requirePasswordForSigning: false,
};

export function parseOperationPolicy(value: unknown): OperationPolicy {
  if (value === undefined || value === null) return { ...DEFAULT_OPERATION_POLICY };
  if (typeof value !== 'object'
      || typeof (value as OperationPolicy).requirePasswordForSends !== 'boolean'
      || typeof (value as OperationPolicy).requirePasswordForSigning !== 'boolean') {
    throw new Error('Password confirmation settings could not be read. Check Security settings before continuing.');
  }
  return {
    requirePasswordForSends: (value as OperationPolicy).requirePasswordForSends,
    requirePasswordForSigning: (value as OperationPolicy).requirePasswordForSigning,
  };
}

export function requiresOperationPassword(policy: OperationPolicy, operation: WalletOperation): boolean {
  return policy.requirePasswordForSigning || (operation === 'send' && policy.requirePasswordForSends);
}

export interface OperationAuthDeps {
  assertActive(wallet: UnlockedWallet): void;
  readPolicy(): Promise<OperationPolicy>;
  verifyPassword(password: string, wallet: UnlockedWallet): Promise<void>;
  prompt(description: string, verify: (password: string) => Promise<void>): Promise<void>;
}

/** A password authorizes one request, without unlocking or extending its session. */
export async function authorizeOperationWith(
  deps: OperationAuthDeps,
  operation: WalletOperation,
  wallet: UnlockedWallet,
  description: string,
  forcePassword = false,
): Promise<void> {
  deps.assertActive(wallet);
  const policy = await deps.readPolicy();
  deps.assertActive(wallet);
  if (forcePassword || requiresOperationPassword(policy, operation)) {
    let verified = false;
    await deps.prompt(description, async (password) => {
      deps.assertActive(wallet);
      await deps.verifyPassword(password, wallet);
      deps.assertActive(wallet);
      verified = true;
    });
    if (!verified) throw new Error('Password confirmation was not completed.');
  }
  deps.assertActive(wallet);
}
