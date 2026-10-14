export function activeVaultAddresses(
  chain: string,
  inbound: Array<{ chain?: string; halted?: boolean }>,
  asgard: Array<{ status?: string; addresses?: Array<{ chain?: string; address?: string }> }>,
): string[];
