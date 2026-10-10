/**
 * C-tips wallet custody: the live lane loads each demo wallet's phrase the way
 * the reviewed demo capture lane does (demo/capture-demo.mjs readWalletPhrase):
 * one NAME=value line, read in-process from an owner-only (0600) regular file
 * owned by this user, validated as a 12 or 24 lowercase-word phrase. The file
 * is never sourced into the environment, so no child process (browsers
 * included) inherits the phrases.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { readWalletPhrase } from '../demo/capture-demo.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The variable names of the owner-approved demo wallets in the custody file. */
export const WALLET_VARIABLES = Object.freeze({
  alice: 'SMOKE_ALICE_MNEMONIC',
  bob: 'SMOKE_BOB_MNEMONIC',
  carol: 'SMOKE_CAROL_MNEMONIC',
});

/**
 * The custody file: `SMOKE_WALLET_FILE`, else the documented location in this
 * checkout (present only in the main checkout, never in a worktree).
 */
export function walletFilePath(env = process.env) {
  const configured = (env.SMOKE_WALLET_FILE ?? '').trim();
  if (configured) return resolve(configured);
  return join(here, '..', '..', 'smoke-tests', 'secrets', 'smoke-mnemonics.env');
}

export function walletFileExists(env = process.env) {
  return existsSync(walletFilePath(env));
}
