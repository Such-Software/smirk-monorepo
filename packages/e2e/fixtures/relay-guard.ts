/**
 * Guard for the specs that PUBLISH to a relay.
 *
 * `comms-roundtrip` and `feed` seal, publish and read back real Nostr events,
 * and the feed test publishes a public kind-1. Their headers say plainly: do
 * not point them at the production relay. But the only machine-checked guard
 * was "does the backend advertise a relay at all", which production satisfies,
 * so pointing the suite at prod ran them anyway.
 *
 * That happened on 2026-08-24. Nothing landed, because production runs
 * `premium-post` and denied every non-wallet kind from a registered-but-not-
 * premium author (verified: zero events on the relay from any smoke wallet).
 * The suite still reported failures that read like broken DMs, and the
 * prohibition deserves to be enforced rather than written down.
 *
 * A publish-capable relay is a LOCAL one: loopback, or plain ws:// on a private
 * address. Anything else, including any wss:// public host, is somebody's real
 * relay and is skipped.
 */
export function isLocalPublishRelay(relayUrl: string | undefined): boolean {
  if (!relayUrl) return false;
  let u: URL;
  try {
    u = new URL(relayUrl);
  } catch {
    return false;
  }
  // wss:// to a public host is production by definition; a local test relay is
  // reached over plain ws.
  if (u.protocol !== 'ws:') return false;
  const h = u.hostname;
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h.endsWith('.local') ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/** Reason string for the skip, naming the relay so the cause is obvious. */
export function publishRelaySkipReason(relayUrl: string | undefined): string {
  return (
    `relay ${relayUrl ?? '(none advertised)'} is not a local test relay; ` +
    'this spec publishes real events and must not run against a production ' +
    'relay (see the spec header for the docker one-liner)'
  );
}

/*
 * Live relay admission (the reviewed exception to the rule above).
 *
 * The v0.3.1 release run exercises NIP-17 messaging against the production
 * relay on purpose, with the owner-approved demo wallets. That is admitted only
 * by an explicit `E2E_LIVE_RELAY=1`, and only for the two kinds the wallet's
 * private messaging needs:
 *
 *   - 1059, the NIP-59 gift wrap that carries a NIP-17 DM. The relay sees
 *     ciphertext under a throwaway key; nothing public is written.
 *   - 10050, the NIP-17 DM inbox relay list.
 *
 * A public kind-1 note lands in the real announcements feed, so it needs more:
 * the author must hold posting rights (premium, as the server reports it) AND
 * the owner must have approved a public note for this run
 * (`E2E_LIVE_FEED_POST=1`). Every other kind stays refused. A local relay
 * remains open to everything, as before.
 *
 * Fails closed: an unparseable relay URL is treated as production, and a
 * missing flag refuses rather than defaulting to "probably fine".
 */

/** Kinds `E2E_LIVE_RELAY=1` admits to a production relay without further approval. */
export const LIVE_RELAY_WALLET_KINDS: readonly number[] = Object.freeze([1059, 10050]);

/** NIP-01 public text note: production only with premium and owner approval. */
export const LIVE_RELAY_NOTE_KIND = 1;

export type LiveRelayDecision = { admit: true } | { admit: false; reason: string };

export interface LiveRelayOptions {
  /** The author's posting rights as the server reports them (premium or allowlisted). */
  premium?: boolean;
  /** Environment to read the flags from (tests pass a fixture; default process.env). */
  env?: Record<string, string | undefined>;
}

/** Whether the owner approved a public kind-1 note for this run. */
export function liveFeedPostApproved(env: Record<string, string | undefined> = process.env): boolean {
  return env.E2E_LIVE_FEED_POST === '1';
}

/**
 * Decide whether an event of `kind` may be published to `relayUrl` in this run.
 * The reason names the rule that refused, never event content.
 */
export function liveRelayAdmits(
  relayUrl: string | undefined,
  kind: number,
  opts: LiveRelayOptions = {},
): LiveRelayDecision {
  const env = opts.env ?? process.env;
  if (isLocalPublishRelay(relayUrl)) return { admit: true };
  if (!relayUrl) return { admit: false, reason: 'no relay is advertised, so there is nowhere to publish' };
  if (env.E2E_LIVE_RELAY !== '1') {
    return {
      admit: false,
      reason: `relay ${relayUrl} is a production relay; publishing to it needs the explicit E2E_LIVE_RELAY=1 live lane`,
    };
  }
  if (LIVE_RELAY_WALLET_KINDS.includes(kind)) return { admit: true };
  if (kind === LIVE_RELAY_NOTE_KIND) {
    if (!opts.premium) {
      return {
        admit: false,
        reason: 'a public note on a production relay needs an author the server lets post (premium)',
      };
    }
    if (!liveFeedPostApproved(env)) {
      return {
        admit: false,
        reason: 'a public note lands in the real feed; the owner must approve it for this run (E2E_LIVE_FEED_POST=1)',
      };
    }
    return { admit: true };
  }
  return {
    admit: false,
    reason: `kind ${kind} is not admitted to a production relay by the live lane (only 1059 and 10050, or an approved premium kind-1)`,
  };
}

/** Throw with the refusal reason unless `liveRelayAdmits` admits the event. */
export function assertLiveRelayAdmits(
  relayUrl: string | undefined,
  kind: number,
  opts: LiveRelayOptions = {},
): void {
  const decision = liveRelayAdmits(relayUrl, kind, opts);
  if (!decision.admit) throw new Error(`relay guard refused kind ${kind}: ${decision.reason}`);
}

/** Skip reason when a live spec cannot publish `kind` here, or null when it may. */
export function liveRelaySkipReason(
  relayUrl: string | undefined,
  kind: number,
  opts: LiveRelayOptions = {},
): string | null {
  const decision = liveRelayAdmits(relayUrl, kind, opts);
  return decision.admit ? null : decision.reason;
}
