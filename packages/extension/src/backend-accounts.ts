/**
 * The backends this wallet holds an account at: every backend it signed in
 * to, and every backend the user switched away from.
 *
 * The dapp signer refuses to sign a NIP-98 HTTP-auth event for these hosts
 * (`dapp-popup/signers.ts`). `POST /auth/nostr` mints a full session from such
 * an event, and the account-0 npub is the same at every backend. The guard
 * used to protect only the backend currently selected, so after any switch a
 * connected site granted account-0 could have the user sign a sign-in token
 * for the backend they had just left, and act as them there.
 *
 * Base URLs only: public configuration, never a credential. Kept across "forget
 * this wallet": refusing a NIP-98 sign-in token for a Smirk backend costs a
 * site nothing legitimate.
 */
import { ChromeLocalStorage } from '@smirk/core';

const KEY = 'smirk_backend_accounts_v1';
/** Most recent first; a wallet does not move between this many operators. */
const MAX_REMEMBERED = 32;

function storage(): ChromeLocalStorage {
  return new ChromeLocalStorage();
}

/** Remember `backendUrl` as a backend this wallet has an account at. */
export async function rememberBackendAccount(backendUrl: string): Promise<void> {
  if (!backendUrl) return;
  const store = storage();
  const known = (await store.get<string[]>(KEY)) ?? [];
  if (known[0] === backendUrl) return;
  const next = [backendUrl, ...known.filter((url) => url !== backendUrl)].slice(0, MAX_REMEMBERED);
  await store.set(KEY, next);
}

/** Every backend remembered by {@link rememberBackendAccount}, most recent first. */
export async function rememberedBackendAccounts(): Promise<string[]> {
  const known = await storage().get<unknown>(KEY);
  return Array.isArray(known) ? known.filter((url): url is string => typeof url === 'string') : [];
}
