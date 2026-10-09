/**
 * The `/auth/extension` refusal for a wallet whose account belongs to another
 * Nostr identity.
 *
 * smirk-backend-core 45b0143 and later refuse to adopt a wallet's BTC key onto
 * an account that was registered under an npub. That row's keys came through
 * `/auth/nostr/register`, which binds them to the npub by TLS alone, so "the
 * stored BTC key equals the submitted one" does not prove this seed owns the
 * npub: whoever learned the wallet's fingerprint and public keys first could
 * have created the row under their own npub. The v0.3.1 client reaches this
 * only after its own npub sign-in was turned away for a seed the backend
 * already knows, so the npub on file is not the one this wallet derives.
 *
 * The answer is HTTP 409 with code `CONFLICT` and the message
 * `NOSTR_ROW_ADOPT_REFUSED` ("This account is registered under a Nostr
 * identity; sign in with it", `src/api/auth.rs`). It is deliberately not
 * PoW-shaped: a solve must never be what completes an adopt onto someone else's
 * npub row, so no client path answers it with proof-of-work or a resend.
 */

/** What the wallet shows for this refusal, in place of the backend's text. */
export const NOSTR_IDENTITY_CONFLICT =
  "This wallet's account is linked to a different Nostr identity; " +
  'sign in with that identity, or contact support.';

/**
 * The distinctive part of the backend message. `CONFLICT` alone is not enough:
 * the same 409 code also answers a taken username and an npub registration for
 * a seed that already has an account (which the client handles by falling back
 * to BTC sign-in).
 */
const NOSTR_ROW_ADOPT_REFUSED_PATTERN = /registered under a nostr identity/i;

/**
 * True when a registration was refused because the seed's account is
 * registered under an npub this wallet did not sign in with. Never a reason to
 * solve proof-of-work or resend; `isPowRequiredRejection` never matches it.
 */
export function isNostrIdentityConflict(result: {
  status?: number;
  code?: string;
  error?: string;
}): boolean {
  return (
    result.status === 409 &&
    result.code === 'CONFLICT' &&
    NOSTR_ROW_ADOPT_REFUSED_PATTERN.test(result.error ?? '')
  );
}
