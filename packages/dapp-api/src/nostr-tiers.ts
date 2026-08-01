/**
 * Nostr event-kind risk tiers (P4, the money-tier session model). A Nostr
 * signature is a credential, so which events a connected origin may sign WITHOUT
 * a fresh per-event prompt is a security decision, not a UX one.
 *
 *   - `money`             — value / authorization events (17, 30402, 22242). NEVER
 *                           auto-signed, NEVER session-grantable. Every one gets an
 *                           explicit, per-event approval with a strong warning.
 *   - `session-grantable` — high-volume, low-risk social events (1, 7, 1059). The
 *                           user MAY grant a time-boxed session so a dapp signs
 *                           these without re-prompting for the window.
 *   - `default`           — everything else: per-event prompt, but not flagged as
 *                           money-tier and not session-grantable (unknown kinds are
 *                           treated conservatively — prompt, never auto-sign).
 *
 * The wallet-handler is the enforcement point: it computes `sessionCovered=false`
 * for anything not session-grantable and refuses to persist a money-tier kind into
 * a session, so the property holds even if the approval UI is buggy or hostile.
 */

/** Value / authorization kinds — never auto-signed. NIP-99 classified listing
 *  (30402), NIP-42 relay auth / login (22242), NIP-98 HTTP auth (27235), and the
 *  Goblin money-tier kind 17.
 *
 *  27235 is here because a NIP-98 event IS a bearer credential: the backend mints
 *  a full session from one (`POST /auth/nostr`). Leaving it session-grantable let
 *  a connected site collect an auth token for the user's own wallet backend. See
 *  the `u`-tag origin guard in `dapp-popup/signers.ts`. */
export const NOSTR_MONEY_TIER_KINDS: readonly number[] = [17, 27235, 30402, 22242];

/** High-volume social kinds a user may session-grant: notes (1), reactions (7),
 *  gift-wraps (1059). */
export const NOSTR_SESSION_GRANTABLE_KINDS: readonly number[] = [1, 7, 1059];

export type NostrKindTier = 'money' | 'session-grantable' | 'default';

export function nostrKindTier(kind: number): NostrKindTier {
  if (NOSTR_MONEY_TIER_KINDS.includes(kind)) return 'money';
  if (NOSTR_SESSION_GRANTABLE_KINDS.includes(kind)) return 'session-grantable';
  return 'default';
}

/** A time-boxed grant to sign specific low-tier kinds without re-prompting. */
export interface NostrSessionGrant {
  /** Session-grantable kinds this session covers. Money-tier kinds are refused. */
  kinds: number[];
  /** Unix ms after which the session is dead. */
  expiresAt: number;
}

/** True iff an active session covers `kind`. A money-tier kind is NEVER covered,
 *  even if a stale/hostile session lists it — the tier check wins. */
export function isNostrSessionActive(
  session: NostrSessionGrant | undefined,
  kind: number,
  nowMs: number,
): boolean {
  if (nostrKindTier(kind) === 'money') return false;
  if (!session) return false;
  return session.expiresAt > nowMs && session.kinds.includes(kind);
}

/**
 * Merge a newly-granted session into any existing one, DROPPING money-tier kinds
 * (defense in depth — a money kind must never be persisted into a session) and
 * any non-session-grantable kind. Returns the session to persist, or undefined if
 * nothing grantable survived.
 */
export function mergeNostrSession(
  existing: NostrSessionGrant | undefined,
  grant: { kinds: number[]; expiresAt: number },
  nowMs: number,
): NostrSessionGrant | undefined {
  const safeKinds = grant.kinds.filter((k) => nostrKindTier(k) === 'session-grantable');
  if (safeKinds.length === 0) return existing;
  // Keep still-live kinds from the existing session, then union the new ones.
  const kept = existing && existing.expiresAt > nowMs ? existing.kinds : [];
  const kinds = [...new Set([...kept, ...safeKinds])];
  return { kinds, expiresAt: grant.expiresAt };
}
