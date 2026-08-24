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
