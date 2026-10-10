/**
 * Node-side Nostr evidence for the live messaging and federation specs.
 *
 * The wallet UI says what it believes; these helpers read what the relay and
 * the NIP-05 endpoints actually hold, so a spec can assert the two agree:
 *
 *   - which gift wraps a recipient's inbox gained (by id, before and after),
 *     and the NIP-13 proof-of-work those wraps carry;
 *   - whether a recipient advertises a NIP-17 inbox (kind 10050), which decides
 *     whether the wallet must show its reach notice;
 *   - a Node-side EXTERNAL identity (random key, never Smirk-registered) that
 *     sends and receives NIP-17 DMs through the wallet's own core wrapping, to
 *     the operator relay only;
 *   - the operator feed exactly as the client computes it, and the owner's
 *     NIP-51 mute list.
 *
 * Every publish goes through `assertLiveRelayAdmits` (with the run's pinned
 * relays) first. Reads (REQ) are unrestricted. Relay evidence on a shared relay
 * is looked up by the ids this run published (`findWraps`), never by "whatever
 * is new", so a concurrent lane cannot satisfy or spoil it. Keys created here
 * exist only in memory for one worker and are registered with the footage
 * canary by the caller.
 */

import {
  MUTE_LIST_KIND,
  NostrClient,
  NostrNotes,
  decryptWrap,
  encodeNpub,
  encodeNsec,
  feedSourcesFromCapability,
  fetchDmWraps,
  generateBurnerIdentity,
  initSmirkMessaging,
  messagingProvider,
  muteListFrom,
  NostrMessagingProvider,
  setMessagingProvider,
  resolveNip05,
  type DisplayNote,
  type FeedCapabilityLike,
  type GiftWrapEvent,
  type NostrIdentity,
} from '@smirk/core';
import { assertLiveRelayAdmits } from './relay-guard.js';

/** The capability fields the D specs branch on. */
export interface DCapabilities {
  features?: { nostr_relay?: boolean; feed?: boolean; premium_relay?: boolean; nostr_identity?: boolean };
  messaging?: { relay_url?: string; write_policy?: string; inbound_pow_bits?: number } | null;
  feed?: FeedCapabilityLike | null;
  chains?: Record<string, { enabled?: boolean } | undefined>;
}

/** GET {base}/capabilities (throws on HTTP failure: absent evidence is not health). */
export async function readCapabilities(base: string): Promise<DCapabilities> {
  const res = await fetch(`${base.replace(/\/$/, '')}/capabilities`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`capabilities answered HTTP ${res.status}`);
  return (await res.json()) as DCapabilities;
}

/** NIP-13 difficulty of an event id: leading zero bits. */
export function leadingZeroBits(idHex: string): number {
  let bits = 0;
  for (let i = 0; i < idHex.length; i++) {
    const nibble = parseInt(idHex[i]!, 16);
    if (Number.isNaN(nibble)) return 0;
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    return bits + (Math.clz32(nibble) - 28);
  }
  return bits;
}

/** x-only hex to npub. */
export function hexToNpub(pubkeyHex: string): string {
  const bytes = new Uint8Array(pubkeyHex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(pubkeyHex.slice(i * 2, i * 2 + 2), 16);
  return encodeNpub(bytes);
}

/** No relay read may hang a paced, hours-long run: every one is bounded. */
const QUERY_TIMEOUT_MS = 30_000;

/**
 * Run `fn` against a FRESH client and close it afterwards, bounded by a
 * timeout. A pooled client kept idle sockets across holds of many minutes, and
 * a query on a socket the relay had quietly dropped never saw EOSE. A timeout
 * fails the step: absent evidence is not an answer.
 */
async function withClient<T>(fn: (c: NostrClient) => Promise<T>, what: string, timeoutMs = QUERY_TIMEOUT_MS): Promise<T> {
  const c = new NostrClient();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(c),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`relay ${what} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    c.close();
  }
}

/** Bound any promise (a Node-side send) the same way. */
async function bounded<T>(work: Promise<T>, what: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Release the Node-side sender's relay sockets (afterAll). */
export function closeNostrReader(): void {
  (messagingProvider() as { close?: () => void }).close?.();
}

/** NIP-59 back-dates wraps by up to two days; look three days back. */
const WRAP_WINDOW_SECS = 3 * 24 * 3600;

/** Ids and NIP-13 difficulty of the gift wraps addressed to `pubkeyHex`. */
export async function inboxWraps(relayUrl: string, pubkeyHex: string): Promise<Map<string, number>> {
  const since = Math.floor(Date.now() / 1000) - WRAP_WINDOW_SECS;
  const events = await withClient(
    (c) => c.querySync([relayUrl], [{ kinds: [1059], '#p': [pubkeyHex], since, limit: 1000 }]),
    'inbox query',
  );
  return new Map(events.map((event) => [event.id, leadingZeroBits(event.id)]));
}

/**
 * Which of `ids` (gift wraps a wallet or this file just published) the relay
 * holds for `pubkeyHex`, as id to NIP-13 difficulty. Polls until every id is
 * there or the timeout passes, then returns what it found. Asking by id keeps
 * the evidence to this run's own wraps: another lane writing to the same demo
 * wallet at the same time can neither satisfy nor spoil the check.
 */
export async function findWraps(
  relayUrl: string,
  pubkeyHex: string,
  ids: Iterable<string>,
  timeoutMs = 60_000,
): Promise<Map<string, number>> {
  const wanted = [...new Set(ids)].filter((id) => /^[0-9a-f]{64}$/.test(id));
  if (wanted.length === 0) return new Map();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await withClient(
      (c) => c.querySync([relayUrl], [{ ids: wanted, kinds: [1059], '#p': [pubkeyHex] }]),
      'wrap lookup',
    );
    const found = new Map(events.filter((e) => wanted.includes(e.id)).map((e) => [e.id, leadingZeroBits(e.id)]));
    if (found.size === wanted.length || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

/**
 * Wait until `pubkeyHex`'s inbox gains at least one wrap not in `before`, and
 * return the new ones (id to difficulty). Empty after the timeout. Only for a
 * disposable local relay that nothing else writes to; on a shared relay use
 * `findWraps` with the ids that were published.
 */
export async function newInboxWraps(
  relayUrl: string,
  pubkeyHex: string,
  before: ReadonlyMap<string, number>,
  timeoutMs = 60_000,
): Promise<Map<string, number>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = await inboxWraps(relayUrl, pubkeyHex);
    const fresh = new Map([...now].filter(([id]) => !before.has(id)));
    if (fresh.size > 0 || Date.now() > deadline) return fresh;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

/** Whether `pubkeyHex` publishes a NIP-17 inbox relay list (kind 10050) on `relayUrl`. */
export async function hasDmInbox(relayUrl: string, pubkeyHex: string): Promise<boolean> {
  const events = await withClient(
    (c) => c.querySync([relayUrl], [{ kinds: [10050], authors: [pubkeyHex], limit: 1 }]),
    'inbox list query',
  );
  return events.length > 0;
}

/**
 * What the wallet should learn when it resolves `name@domain`: the pubkey and
 * the relay hints the domain's NIP-05 document advertises.
 */
export async function nip05Expectation(handle: string): Promise<{ pubkeyHex: string; relays: string[] } | null> {
  const resolved = await bounded(resolveNip05(handle), 'NIP-05 lookup', QUERY_TIMEOUT_MS);
  if (!resolved.ok) return null;
  return { pubkeyHex: resolved.resolution.pubkeyHex, relays: resolved.resolution.relays ?? [] };
}

/** A Node-side identity that no Smirk backend knows. */
export interface ExternalIdentity {
  identity: NostrIdentity;
  npub: string;
  pubkeyHex: string;
}

export function createExternalIdentity(): ExternalIdentity {
  const identity = generateBurnerIdentity();
  return { identity, npub: identity.npub, pubkeyHex: identity.pubkeyHex };
}

/** The secret forms of an external identity, for the footage canary only. */
export function externalSecretForms(external: ExternalIdentity): string[] {
  const hex = Array.from(external.identity.privateKey, (b) => b.toString(16).padStart(2, '0')).join('');
  return [hex, encodeNsec(external.identity.privateKey)];
}

/**
 * Outcome of a Node-side send: accepted, or the relay's own refusal text. Either
 * way `ids` names the gift wraps that were offered to the relay (public event ids).
 */
export type ExternalSend = { ok: true; ids: string[] } | { ok: false; refusal: string; ids: string[] };

/**
 * Send a NIP-17 DM from an external identity through the wallet's own core
 * wrapping (`NostrMessagingProvider.sendDm`: kind-14 rumor, kind-13 seal,
 * kind-1059 wrap, optional NIP-13 mining) to `relayUrl` ONLY. Core's top-level
 * `sendDm` would also publish to the recipient's kind-10050 inbox relays and
 * NIP-05 hints, which this Node process cannot guard at the transport, so the
 * relay set is pinned here instead. `pinned` is the run's pin list
 * (fixtures/relay-guard.ts); `relayUrl` must be on it.
 */
export async function sendFromExternal(
  relayUrl: string,
  pinned: readonly string[],
  from: ExternalIdentity,
  recipientPubkeyHex: string,
  text: string,
  powBits: number,
): Promise<ExternalSend> {
  assertLiveRelayAdmits(relayUrl, 1059, { pinned });
  const provider = new NostrMessagingProvider();
  const ids: string[] = [];
  // Every publish goes through the provider's one internal `publish`; record
  // the id of each event it ships so the caller can find exactly these wraps.
  const spied = provider as unknown as {
    publish: (relays: string[], event: { id: string }) => Promise<void>;
  };
  const publish = spied.publish.bind(provider);
  spied.publish = async (relays, event) => {
    ids.push(event.id);
    return publish(relays, event);
  };
  try {
    await bounded(
      provider.sendDm({
        identity: from.identity,
        recipientPubkeyHex,
        text,
        relays: [relayUrl],
        ...(powBits ? { powBits } : {}),
      }),
      'Node-side relay exchange',
      60_000,
    );
    return { ok: true, ids };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, refusal: message, ids };
  } finally {
    provider.close();
  }
}

/**
 * Run `fn` with a fresh messaging provider on `relayUrl` only, closed after.
 * Same reason as `withClient`: no pooled socket outlives a step.
 */
async function withProvider<T>(relayUrl: string, fn: () => Promise<T>): Promise<T> {
  const provider = new NostrMessagingProvider();
  setMessagingProvider(provider);
  initSmirkMessaging({ relayUrl, publicRelays: [] });
  try {
    return await bounded(fn(), 'Node-side relay exchange', 60_000);
  } finally {
    provider.close();
  }
}

/** Plain texts an external identity can decrypt from its inbox on `relayUrl`. */
export async function externalInboxTexts(relayUrl: string, to: ExternalIdentity): Promise<string[]> {
  const since = Math.floor(Date.now() / 1000) - WRAP_WINDOW_SECS;
  const wraps: GiftWrapEvent[] = await withProvider(relayUrl, () => fetchDmWraps(to.pubkeyHex, since));
  return wraps
    .map((wrap) => decryptWrap(to.identity, wrap))
    .filter((dm): dm is NonNullable<typeof dm> => dm !== null)
    .map((dm) => dm.text);
}

/** The operator feed as the client computes it, plus the owner's mute list. */
export interface FeedExpectation {
  notes: DisplayNote[];
  /** Whether the owner published a mute list at all. */
  muteListPublished: boolean;
  mutedAuthors: Set<string>;
  mutedNotes: Set<string>;
  /** General notes on the relay that the mute list hides (the control set). */
  hiddenByMutes: DisplayNote[];
}

export async function feedExpectation(feed: FeedCapabilityLike): Promise<FeedExpectation> {
  const { sources, relayUrl } = feedSourcesFromCapability(feed);
  const notes = await withClient((c) => new NostrNotes(c).fetchFeed(sources, relayUrl, { limit: 50 }), 'feed query');
  const moderator = sources.moderator;
  const muteEvents = moderator
    ? await withClient(
        (c) => c.querySync([relayUrl], [{ kinds: [MUTE_LIST_KIND], authors: [moderator], limit: 1 }]),
        'mute list query',
      )
    : [];
  const mutes = moderator ? muteListFrom(muteEvents, moderator) : { authors: new Set<string>(), notes: new Set<string>() };
  // The control set: what the feed would show with no mute list applied (no
  // moderator to read one from, and no operator-configured mutes).
  const { moderator: _moderator, mutedAuthors: _muted, ...openSources } = sources;
  const unmuted = await withClient(
    (c) => new NostrNotes(c).fetchFeed(openSources, relayUrl, { limit: 50 }),
    'unmuted feed query',
  );
  const shown = new Set(notes.map((n) => n.id));
  const hiddenByMutes = unmuted.filter(
    (n) => !shown.has(n.id) && (mutes.authors.has(n.pubkeyHex) || mutes.notes.has(n.id)),
  );
  return {
    notes,
    muteListPublished: muteEvents.length > 0,
    mutedAuthors: mutes.authors,
    mutedNotes: mutes.notes,
    hiddenByMutes,
  };
}

/** The author prefix and suffix the feed renders for a note (`FeedNote`). */
export function feedAuthorLabel(note: DisplayNote): string {
  return `${note.npub.slice(0, 12)}…${note.npub.slice(-4)}`;
}
