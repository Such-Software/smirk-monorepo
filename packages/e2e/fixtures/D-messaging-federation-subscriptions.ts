/**
 * Gift-wrap subscriptions a wallet page holds, with their lifetimes. Public
 * metadata only: the relay host, the keys a REQ listens for, and when it
 * opened and closed.
 *
 * Which socket a screen uses proves nothing in the popup: every relay user
 * shares one SimplePool, so Messages reuses whatever socket the 30 s tip poll
 * opened first (2026-10-14, d-federation :166). The REQ itself does not tell
 * them apart either: the tip poll's readNpubTips and Messages' subscribeDms
 * send the same {kinds:[1059], '#p':[self]} filter. Their lifetimes differ.
 * The tip poll is a querySync, which sends CLOSE at EOSE (or at nostr-tools'
 * EOSE timeout, under 5 s); Messages keeps its subscription open until the
 * screen unmounts. A subscription still open well past that is the screen's.
 */

export interface WrapSubscription {
  /** The keys the REQ listens for (#p). */
  p: string[];
  /** The relay host it went to. */
  host: string;
  /** When the REQ passed the guard. */
  at: number;
  /** When a CLOSE for it passed, or a REQ reused its id; absent while it is open. */
  closedAt?: number;
}

/** Tracks one socket's subscriptions by id, appending each REQ to `log`. */
export function wrapSubscriptionTracker(log: WrapSubscription[], host: string) {
  const open = new Map<string, WrapSubscription>();
  const end = (subId: string, now: number) => {
    const sub = open.get(subId);
    if (!sub) return;
    sub.closedAt ??= now;
    open.delete(subId);
  };
  return {
    /** A REQ for kind 1059; a REQ that reuses an open id replaces it (NIP-01). */
    req(subId: string, p: string[], now = Date.now()): void {
      end(subId, now);
      const sub: WrapSubscription = { p, host, at: now };
      log.push(sub);
      open.set(subId, sub);
    },
    /** A CLOSE from the page, or a CLOSED from the relay: ends the subscription with that id, if this tracker opened it. */
    close(subId: string, now = Date.now()): void {
      end(subId, now);
    },
  };
}

/**
 * The subscription id a relay's CLOSED frame ends (NIP-01: the relay refused
 * or dropped that subscription), or null for any other frame. A REQ the relay
 * refused at once is not a screen listening, however long the page leaves it
 * open on its side.
 */
export function relayClosedSubId(message: string): string | null {
  if (!message.slice(0, 16).includes('"CLOSED"')) return null;
  try {
    const frame: unknown = JSON.parse(message);
    return Array.isArray(frame) && frame[0] === 'CLOSED' && typeof frame[1] === 'string' ? frame[1] : null;
  } catch {
    return null;
  }
}

/** How long a subscription must stay open to count as a screen's, not a one-shot query. */
export const LIVE_SUBSCRIPTION_MS = 10_000;

/**
 * Whether a gift-wrap subscription for `p` on `host`, opened at or after
 * `since`, is still open and has been for at least `heldMs`.
 */
export function liveWrapSubscription(
  log: readonly WrapSubscription[],
  want: { host: string; p: string; since: number; now?: number; heldMs?: number },
): boolean {
  const now = want.now ?? Date.now();
  const heldMs = want.heldMs ?? LIVE_SUBSCRIPTION_MS;
  return log.some(
    (s) => s.host === want.host && s.at >= want.since && s.closedAt === undefined && s.p.includes(want.p) && now - s.at >= heldMs,
  );
}
