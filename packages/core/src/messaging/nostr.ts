/**
 * Nostr MessagingProvider: the default adapter.
 *
 * NIP-17 private DMs over NIP-59 gift-wrap. Sending uses nostr-tools' vetted
 * `nip17` (kind-14 rumor, kind-13 seal, kind-1059 gift-wrap), which keeps the
 * wire format compatible with other wallets and Goblin. Receiving does NOT use
 * nostr-tools' `unwrapEvent`: it goes through {@link unwrapDmSecurely}, which
 * verifies the seal signature and binds the seal author to the rumor author,
 * the anti-impersonation check nostr-tools omits. Relay I/O via `SimplePool`
 * (browser global WebSocket).
 */

import { SimplePool } from 'nostr-tools/pool';
import { wrapEvent } from 'nostr-tools/nip17';
import { createRumor, createSeal } from 'nostr-tools/nip59';
import { encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import { getPow } from 'nostr-tools/nip13';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';

import type { NostrIdentity } from '../nostr';
import { unwrapRumorSecurely } from '../nostr/giftwrap';
import type { MessagingProvider } from './provider';
import type { DirectMessage, DmSubscription, GiftWrapEvent } from './types';

/** NIP-59 gift-wrap. */
const GIFT_WRAP_KIND = 1059;
/** NIP-17 DM-inbox relay list. */
const DM_RELAY_LIST_KIND = 10050;

/**
 * Securely unwrap a NIP-59 gift-wrap DM. Delegates to the shared, hardened
 * {@link unwrapRumorSecurely} (verifies the kind-13 seal signature + enforces
 * seal.pubkey === rumor.pubkey, the anti-impersonation check nostr-tools'
 * `unwrapEvent` omits). Re-exported here for the existing DM call sites.
 */
export const unwrapDmSecurely = unwrapRumorSecurely;

/**
 * Verifying-decrypt a raw gift-wrap into a display DirectMessage, or null if it
 * can't be securely opened. Shared by the live subscription and the background
 * poller's stored-wrap decryption in the popup.
 */
export function wrapToDirectMessage(
  wrap: { id?: string; pubkey: string; content: string },
  recipientSk: Uint8Array,
): DirectMessage | null {
  const rumor = unwrapDmSecurely(wrap, recipientSk);
  if (!rumor) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  // The rumor `id`/`created_at` are UNSIGNED (inside the encrypted layer): the
  // authenticated seal only binds the AUTHOR, not these fields. So an
  // authenticated-but-malicious sender can pick a `created_at` far in the future
  // (pin-to-top) or a colliding `id` (dedup-suppress another message). Key off
  // the content-addressed, pool-verified gift-wrap `id` instead, and clamp a
  // future `created_at` to now (NIP-59 back-dates for privacy, so only the
  // future is anomalous).
  const rawCreated =
    typeof rumor.created_at === 'number' && Number.isFinite(rumor.created_at)
      ? rumor.created_at
      : nowSec;
  return {
    id: wrap.id ?? rumor.id ?? '',
    fromPubkeyHex: rumor.pubkey,
    fromNpub: npubEncode(rumor.pubkey),
    text: rumor.content,
    createdAt: Math.min(rawCreated, nowSec + 300),
  };
}

/**
 * Build a gift wrap whose id carries `difficulty` leading zero bits (NIP-13).
 *
 * Relays increasingly gate delivery from authors they do not know behind
 * proof-of-work: ours requires 8 bits for a gift wrap from an unregistered
 * npub, and without it every message from a burner or a fresh identity is
 * refused. That matters more as identities get cheaper to create, not less.
 *
 * nostr-tools' `minePow` is not usable here. It resets `created_at` to the
 * current second on every iteration, and NIP-59 deliberately BACKDATES the wrap
 * by a random interval so the timestamp cannot be correlated with when you
 * actually sent it. Mining with it would buy relay admission by leaking send
 * time. Only the nonce varies here; the randomised timestamp survives.
 *
 * 8 bits averages 256 hashes, which is imperceptible. The cost is exponential
 * in the bit count, so a relay demanding a large difficulty will be slow by
 * design, and the caller decides whether that is worth it.
 */
function wrapWithPow(
  sealed: ReturnType<typeof createSeal>,
  recipientPublicKey: string,
  difficulty: number,
): ReturnType<typeof finalizeEvent> {
  const ephemeral = generateSecretKey();
  // Same shape createWrap produces, including NIP-59's backdated timestamp.
  const base = {
    kind: GIFT_WRAP_KIND,
    content: nip44Encrypt(
      JSON.stringify(sealed),
      getConversationKey(ephemeral, recipientPublicKey),
    ),
    created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800),
    pubkey: getPublicKey(ephemeral),
  };
  if (difficulty <= 0) {
    const { pubkey: _drop, ...rest } = base;
    return finalizeEvent({ ...rest, tags: [['p', recipientPublicKey]] }, ephemeral);
  }
  const tags: string[][] = [
    ['p', recipientPublicKey],
    ['nonce', '0', String(difficulty)],
  ];
  const nonceTag = tags[1]!;
  for (let count = 1; ; count++) {
    nonceTag[1] = String(count);
    if (getPow(getEventHash({ ...base, tags })) >= difficulty) break;
  }
  const { pubkey: _drop, ...rest } = base;
  // finalizeEvent recomputes the id over these exact bytes, so the mined id is
  // the one that ships.
  return finalizeEvent({ ...rest, tags }, ephemeral);
}

export class NostrMessagingProvider implements MessagingProvider {
  readonly kind = 'nostr';
  private pool = new SimplePool();
  /** Relays we've touched, so `close()` can release them. */
  private relaysSeen = new Set<string>();

  private async publish(relays: string[], event: Parameters<SimplePool['publish']>[1]): Promise<void> {
    relays.forEach((r) => this.relaysSeen.add(r));
    const results = await Promise.allSettled(this.pool.publish(relays, event));
    if (results.some((r) => r.status === 'fulfilled')) return;

    // Relays say WHY they refused, in the OK message, and nostr-tools rejects
    // with it. Throwing a bare "failed to publish to any relay" discarded the
    // one piece of information that tells a user what to do: an unregistered
    // identity, a missing proof-of-work, a membership requirement and an
    // unreachable relay all produced the same dead end.
    const reasons = [
      ...new Set(
        results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => {
            const e = r.reason;
            const msg = e instanceof Error ? e.message : String(e ?? '');
            // nostr-tools prefixes the relay's text; keep the text itself.
            return msg.replace(/^.*?:\s*/, '').trim();
          })
          .filter((m) => m.length > 0),
      ),
    ];
    throw new Error(
      reasons.length > 0
        ? `relay refused this message: ${reasons.join('; ')}`
        : 'could not reach any relay to send this message',
    );
  }

  async sendDm({
    identity,
    recipientPubkeyHex,
    text,
    relays,
    powBits,
  }: {
    identity: NostrIdentity;
    recipientPubkeyHex: string;
    text: string;
    relays: string[];
    powBits?: number;
  }): Promise<void> {
    const difficulty = powBits ?? 0;
    let giftWrap;
    if (difficulty > 0) {
      const rumor = createRumor({ kind: 14, content: text, tags: [['p', recipientPubkeyHex]] }, identity.privateKey);
      const seal = createSeal(rumor, identity.privateKey, recipientPubkeyHex);
      giftWrap = wrapWithPow(seal, recipientPubkeyHex, difficulty);
    } else {
      giftWrap = wrapEvent(identity.privateKey, { publicKey: recipientPubkeyHex }, text);
    }
    await this.publish(relays, giftWrap);
  }

  async publishWrap({ wrap, relays }: { wrap: GiftWrapEvent; relays: string[] }): Promise<void> {
    await this.publish(relays, wrap as unknown as Parameters<SimplePool['publish']>[1]);
  }

  subscribeDms({
    identity,
    relays,
    onMessage,
  }: {
    identity: NostrIdentity;
    relays: string[];
    onMessage: (dm: DirectMessage) => void;
  }): DmSubscription {
    relays.forEach((r) => this.relaysSeen.add(r));
    const sub = this.pool.subscribeMany(
      relays,
      { kinds: [GIFT_WRAP_KIND], '#p': [identity.pubkeyHex] },
      {
        onevent: (evt: { id?: string; pubkey: string; content: string }) => {
          // Verifying unwrap: skips anything with a bad seal sig or a
          // seal/rumor author mismatch (impersonation); see unwrapDmSecurely.
          const dm = wrapToDirectMessage(evt, identity.privateKey);
          if (dm) onMessage(dm);
        },
      },
    );
    return { close: () => sub.close() };
  }

  async queryDmWraps({
    pubkeyHex,
    relays,
    sinceSec,
  }: {
    pubkeyHex: string;
    relays: string[];
    sinceSec?: number | undefined;
  }): Promise<GiftWrapEvent[]> {
    relays.forEach((r) => this.relaysSeen.add(r));
    const filter: { kinds: number[]; '#p': string[]; since?: number } = {
      kinds: [GIFT_WRAP_KIND],
      '#p': [pubkeyHex],
    };
    if (sinceSec) filter.since = sinceSec;
    const events = await this.pool.querySync(relays, filter);
    return events as unknown as GiftWrapEvent[];
  }

  async queryDmRelayList({
    pubkeyHex,
    relays,
  }: {
    pubkeyHex: string;
    relays: string[];
  }): Promise<string[]> {
    relays.forEach((r) => this.relaysSeen.add(r));
    // The recipient's most recent kind-10050; its `relay` tags are their inbox.
    const events = await this.pool.querySync(relays, {
      kinds: [DM_RELAY_LIST_KIND],
      authors: [pubkeyHex],
    });
    let latest: { created_at: number; tags: string[][] } | undefined;
    for (const e of events as unknown as { created_at: number; tags: string[][] }[]) {
      if (!latest || e.created_at > latest.created_at) latest = e;
    }
    if (!latest) return [];
    return latest.tags
      .filter((t) => t[0] === 'relay' && typeof t[1] === 'string' && t[1])
      .map((t) => t[1] as string);
  }

  async publishDmRelayList({
    identity,
    relays,
    inboxRelays,
  }: {
    identity: NostrIdentity;
    relays: string[];
    inboxRelays: string[];
  }): Promise<void> {
    const event = finalizeEvent(
      {
        kind: DM_RELAY_LIST_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: inboxRelays.map((r) => ['relay', r]),
        content: '',
      },
      identity.privateKey,
    );
    await this.publish(relays, event);
  }

  close(): void {
    this.pool.close([...this.relaysSeen]);
    this.relaysSeen.clear();
  }
}
