export function readWalletPhrase(file: string, variable: string): string[];
export const WALLET_VARIABLES: Readonly<{ alice: string; bob: string; carol: string }>;
export function walletFilePath(env?: Record<string, string | undefined>): string;
export function walletFileExists(env?: Record<string, string | undefined>): boolean;
