/**
 * Per-wallet SmirkApi factory + authenticated bootstrap.
 *
 * Each test wallet gets its own `SmirkApi` instance so JWT bearer
 * tokens don't bleed between them (the singleton `api` in
 * `@smirk/core` is shared by the popup, which only ever has one
 * authed user at a time).
 */

import {
  SmirkApi,
  bootstrapAuth,
  type BootstrapAuthResult,
  type UnlockedWallet,
} from '@smirk/core';

export interface AuthedClient {
  api: SmirkApi;
  bootstrap: BootstrapAuthResult;
}

/**
 * Make a fresh `SmirkApi` pointed at `baseUrl`, run the full bootstrap
 * (checkRestore → optional PoW → extensionRegister), and return both
 * the authed client and the bootstrap result so callers can read
 * `userId` / start-heights / etc.
 *
 * Test wallets are pre-registered out-of-band (manual extension
 * onboarding once), so `isKnownWallet` will be true and the
 * bootstrap skips the PoW solve entirely — same fast path as
 * production lock+unlock.
 */
export async function authedApi(
  baseUrl: string,
  wallet: UnlockedWallet,
): Promise<AuthedClient> {
  const api = new SmirkApi(baseUrl);
  const bootstrap = await bootstrapAuth(api, wallet);
  return { api, bootstrap };
}
