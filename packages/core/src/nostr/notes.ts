/**
 * Notes + feed plane (kind-1): the in-app Nostr social surface.
 *
 * Read a feed (subscription filters to relays) and post notes, built on
 * `NostrClient`. Three seams are deliberate so the MVP extends cleanly to a fuller
 * social client without call-site churn:
 *   - `resolvePostingIdentity`: which npub a note is signed under (main today;
 *     a rotated social sub-identity plugs in later).
 *   - `resolvePublishRelays`:   where a note goes (operator relay today; optional
 *     public-relay fallback later).
 *   - `postingRequirement`:     capability-driven gate; NEVER hardcodes the
 *     paywall: an operator can run open, premium-post, or free premium.
 */

import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { npubEncode, decode as decodeNip19 } from 'nostr-tools/nip19';

import type { NostrIdentity } from './identity';
import type { NostrClient, NostrFilter, NostrWireEvent } from './client';

/** NIP-01 text note. */
export const NOTE_KIND = 1;

/** A note projected for display (only validly-signed events reach here). */
export interface DisplayNote {
  id: string;
  pubkeyHex: string;
  npub: string;
  content: string;
  createdAt: number;
  tags: string[][];
}

/**
 * Operator-advertised feed sources (from the backend `feed` capability). A feed is
 * just relay subscription filters: notes by these authors and/or notes carrying
 * these hashtags, pulled from the operator relay plus any listed relays.
 */
export interface FeedSources {
  /** Author pubkeys to include (e.g. the Smirk announcements account). */
  authors?: string[];
  /** Hashtag (`#t`) values to include (without the leading `#`). */
  hashtags?: string[];
  /** Extra relays to pull author/hashtag notes from, beyond the operator relay. */
  relays?: string[];
  /**
   * Pull EVERY general note from the operator relay, not just listed authors.
   *
   * Set from the operator's `show_premium`. The relay is write-gated, so on a
   * `premium-post` instance every general note on it is already by a premium
   * member or an allowlisted operator account: the admission policy is the
   * filter, and re-deriving one client-side would need a membership list the
   * client cannot have.
   */
  includeRelayGeneral?: boolean;
}

/** Structural shape of the backend `feed` capability, kept local so this Nostr
 *  module doesn't import the api-layer type. Matches `FeedCapability`. */
export interface FeedCapabilityLike {
  relay_url: string;
  show_owner: boolean;
  /** Include premium members' posts. Optional so an older backend that never
   *  sent it keeps its current author-only behaviour instead of opening up. */
  show_premium?: boolean;
  owner_npub: string | null;
  allowlist_npubs: string[];
  extra_relays: string[];
}

/**
 * Map an operator `feed` capability to relay-subscription {@link FeedSources} plus
 * the primary relay. npubs are decoded to hex pubkeys (Nostr author filters key on
 * hex); a malformed npub is skipped rather than thrown, so one bad allowlist entry
 * can't blank the whole feed.
 */
export function feedSourcesFromCapability(feed: FeedCapabilityLike): {
  sources: FeedSources;
  relayUrl: string;
} {
  const authors: string[] = [];
  const add = (npub: string): void => {
    try {
      const d = decodeNip19(npub);
      if (d.type === 'npub' && typeof d.data === 'string') authors.push(d.data);
    } catch {
      /* skip a malformed npub */
    }
  };
  if (feed.show_owner && feed.owner_npub) add(feed.owner_npub);
  for (const n of feed.allowlist_npubs ?? []) add(n);
  return {
    sources: {
      authors,
      relays: feed.extra_relays ?? [],
      includeRelayGeneral: feed.show_premium === true,
    },
    relayUrl: feed.relay_url,
  };
}

/** Whether the user may post to the operator relay right now, per its policy. */
export type PostingRequirement =
  | { kind: 'allowed' }
  | { kind: 'needs-premium' }
  | { kind: 'no-relay' };

/**
 * Identity seam: the identity a note is posted under. Returns the main identity
 * today; a rotated per-social sub-identity replaces this later without touching
 * any caller.
 */
export function resolvePostingIdentity(identity: NostrIdentity): NostrIdentity {
  return identity;
}

/**
 * Relay seam: the relay set a note is published to. Operator relay only for the
 * MVP; a public-relay fallback (damus/nos.lol) can be folded in later as an
 * explicit, opt-in extension of this set.
 */
export function resolvePublishRelays(
  operatorRelay: string | undefined,
  opts?: { publicFallback?: string[] },
): string[] {
  const set = new Set<string>();
  if (operatorRelay) set.add(operatorRelay);
  for (const r of opts?.publicFallback ?? []) set.add(r);
  return [...set];
}

/**
 * Capability-driven posting gate. Reads the operator's relay policy + the user's
 * premium status; it NEVER hardcodes a paywall. Only `premium-post` WITHOUT
 * premium blocks; open / inbox-outbox / author-allowlist / a premium holder / a
 * free-premium operator all resolve to `allowed`.
 */
export function postingRequirement(caps: {
  relayUrl?: string;
  writePolicy?: string;
  hasPremium: boolean;
  /**
   * The server's own decision from `GET /premium/status` (`can_post_general`).
   * Authoritative when present.
   *
   * Re-deriving posting rights on the client from `write_policy` + premium is
   * WRONG and shipped that way: it cannot see the operator write-allowlist, so
   * an allowlisted operator was shown "needs premium" and the composer was
   * hidden even though the relay would have accepted the event. Left optional
   * so an older backend still degrades to the legacy derivation.
   */
  canPostGeneral?: boolean;
}): PostingRequirement {
  if (!caps.relayUrl) return { kind: 'no-relay' };
  if (caps.canPostGeneral !== undefined) {
    return caps.canPostGeneral ? { kind: 'allowed' } : { kind: 'needs-premium' };
  }
  if (caps.writePolicy === 'premium-post' && !caps.hasPremium) {
    return { kind: 'needs-premium' };
  }
  return { kind: 'allowed' };
}

/** NIP-01 kind-0 profile metadata (replaceable: relays keep only the newest). */
export const PROFILE_KIND = 0;

/** kind-0 profile content. Only the fields we own are set; callers may extend
 *  (about, picture, lud16…) without any signature-shape change. */
export interface NostrProfile {
  /** Short handle (usually the Smirk username). */
  name?: string;
  /** Human display name. */
  display_name?: string;
  /** `<username>@<homeDomain>`: the verifiable handle external clients check
   *  against https://<homeDomain>/.well-known/nostr.json. */
  nip05?: string;
  about?: string;
  picture?: string;
  lud16?: string;
}

/**
 * Build + sign a kind-0 profile (metadata) under the posting identity. Mirrors
 * {@link buildNoteEvent}: `content` is the JSON-stringified profile, `tags` empty.
 * kind-0 is REPLACEABLE, so publishing this overwrites the npub's prior profile;
 * callers that want to preserve other clients' fields should merge first.
 */
export function buildProfileEvent(identity: NostrIdentity, profile: NostrProfile): NostrWireEvent {
  const signer = resolvePostingIdentity(identity);
  const clean = Object.fromEntries(
    Object.entries(profile).filter(([, v]) => v != null && v !== ''),
  );
  return finalizeEvent(
    {
      kind: PROFILE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(clean),
    },
    signer.privateKey,
  ) as unknown as NostrWireEvent;
}

/** Build + sign a kind-1 note under the (seam-resolved) posting identity. */
export function buildNoteEvent(
  text: string,
  identity: NostrIdentity,
  extraTags: string[][] = [],
): NostrWireEvent {
  const signer = resolvePostingIdentity(identity);
  return finalizeEvent(
    {
      kind: NOTE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: extraTags,
      content: text,
    },
    signer.privateKey,
  ) as unknown as NostrWireEvent;
}

/** Project a wire event into a display note, or null if it is not a validly-signed
 *  kind-1 (we never render an unsigned / wrong-kind event). */
export function toDisplayNote(evt: NostrWireEvent): DisplayNote | null {
  if (evt?.kind !== NOTE_KIND || typeof evt.content !== 'string') return null;
  if (!verifyEvent(evt as never)) return null;
  return {
    id: evt.id,
    pubkeyHex: evt.pubkey,
    npub: npubEncode(evt.pubkey),
    content: evt.content,
    createdAt: evt.created_at,
    tags: evt.tags ?? [],
  };
}

/** Turn operator feed sources into NIP-01 subscription filters (one per source
 *  kind, merged/deduped downstream by the client). */
export function feedFilters(sources: FeedSources, limit = 100): NostrFilter[] {
  const filters: NostrFilter[] = [];
  if (sources.authors?.length) {
    filters.push({ kinds: [NOTE_KIND], authors: sources.authors, limit });
  }
  if (sources.hashtags?.length) {
    filters.push({ kinds: [NOTE_KIND], '#t': sources.hashtags, limit });
  }
  return filters;
}

/**
 * The author-less filter for {@link FeedSources.includeRelayGeneral}: every
 * general note the OPERATOR relay will serve.
 *
 * Deliberately NOT part of {@link feedFilters}. Those filters fan out to
 * `extra_relays` as well, and an author-less kind-1 subscription against a
 * public relay is the whole firehose, not a curated feed. The admission policy
 * of the operator's own relay is what makes this filter safe, so it may only
 * ever be sent there.
 */
export function operatorFeedFilters(sources: FeedSources, limit = 100): NostrFilter[] {
  return sources.includeRelayGeneral ? [{ kinds: [NOTE_KIND], limit }] : [];
}

/** The notes/feed API over a shared {@link NostrClient}. */
export class NostrNotes {
  constructor(private readonly client: NostrClient) {}

  /** Sign + publish a note. Callers gate on {@link postingRequirement} first and
   *  resolve relays via {@link resolvePublishRelays}. Returns the display note. */
  async publishNote(
    text: string,
    identity: NostrIdentity,
    relays: string[],
    extraTags: string[][] = [],
  ): Promise<DisplayNote> {
    const event = buildNoteEvent(text, identity, extraTags);
    await this.client.publish(relays, event);
    // Our own freshly-signed event verifies by construction.
    return toDisplayNote(event) as DisplayNote;
  }

  /** Fetch the current feed from the operator relay + any source relays, newest
   *  first. Only validly-signed kind-1 notes are returned. */
  async fetchFeed(
    sources: FeedSources,
    operatorRelay: string | undefined,
    opts?: { limit?: number },
  ): Promise<DisplayNote[]> {
    const relays = resolvePublishRelays(operatorRelay, {
      publicFallback: sources.relays ?? [],
    });
    if (!relays.length) return [];

    // Two scopes, because they are not safe on the same relay set: curated
    // author/hashtag filters may go anywhere, while the author-less general
    // filter is only meaningful (and only bounded) on the operator's own relay.
    const curated = feedFilters(sources, opts?.limit);
    const general = operatorRelay ? operatorFeedFilters(sources, opts?.limit) : [];
    if (!curated.length && !general.length) return [];

    const batches = await Promise.all([
      curated.length ? this.client.querySync(relays, curated) : Promise.resolve([]),
      general.length ? this.client.querySync([operatorRelay!], general) : Promise.resolve([]),
    ]);

    // An author listed AND present on the operator relay arrives twice.
    const seen = new Set<string>();
    return batches
      .flat()
      .map(toDisplayNote)
      .filter((n): n is DisplayNote => n !== null)
      .filter((n) => !seen.has(n.id) && seen.add(n.id))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}
