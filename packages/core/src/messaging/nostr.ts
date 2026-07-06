/**
 * Nostr MessagingProvider — the default adapter.
 *
 * NIP-17 private DMs over NIP-59 gift-wrap, using nostr-tools' vetted `nip17`
 * (which builds the kind-14 rumor, seals it kind-13, gift-wraps it kind-1059, and
 * — critically for cross-wallet/Goblin interop — binds + verifies the seal author
 * to the rumor author). Relay I/O via `SimplePool` (browser global WebSocket).
 */

import { SimplePool } from 'nostr-tools/pool';
import { wrapEvent } from 'nostr-tools/nip17';
import { decrypt as nip44Decrypt, getConversationKey } from 'nostr-tools/nip44';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';

import type { NostrIdentity } from '../nostr';
import type { MessagingProvider } from './provider';
import type { DirectMessage, DmSubscription, GiftWrapEvent } from './types';

/** NIP-59 gift-wrap. */
const GIFT_WRAP_KIND = 1059;
/** NIP-59 seal (signed by the real sender). */
const SEAL_KIND = 13;
/** NIP-17 DM rumor (unsigned inner message). */
const DM_RUMOR_KIND = 14;
/** NIP-17 DM-inbox relay list. */
const DM_RELAY_LIST_KIND = 10050;

/**
 * Securely unwrap a NIP-59 gift-wrap. nostr-tools' `unwrapEvent` (2.23.x) only
 * DECRYPTS the two layers — it does NOT verify the seal's signature nor that the
 * seal author equals the rumor author, so its returned `pubkey` is attacker-
 * controllable (sender impersonation: a random ephemeral key can wrap a rumor
 * claiming ANY npub as the author). We decrypt each layer ourselves, require the
 * seal to be a validly-signed kind-13 event, and enforce `seal.pubkey ===
 * rumor.pubkey` before trusting the sender. Returns the rumor, or null on any
 * failure. This is the load-bearing anti-impersonation check.
 */
export function unwrapDmSecurely(
  wrap: { pubkey: string; content: string; id?: string },
  recipientSk: Uint8Array,
): { pubkey: string; content: string; created_at: number; id?: string } | null {
  try {
    // Layer 1: gift-wrap (1059) → seal, decrypted with the wrap's ephemeral key.
    const seal = JSON.parse(
      nip44Decrypt(wrap.content, getConversationKey(recipientSk, wrap.pubkey)),
    );
    // The seal MUST be a validly self-signed kind-13 (proves seal.pubkey signed it).
    if (seal?.kind !== SEAL_KIND || !verifyEvent(seal)) return null;
    // Layer 2: seal → rumor, decrypted with the (now-authenticated) seal author key.
    const rumor = JSON.parse(
      nip44Decrypt(seal.content, getConversationKey(recipientSk, seal.pubkey)),
    );
    if (rumor?.kind !== DM_RUMOR_KIND || typeof rumor.content !== 'string') return null;
    // The check nostr-tools omits: the claimed sender IS the seal signer.
    if (rumor.pubkey !== seal.pubkey) return null;
    return rumor;
  } catch {
    return null;
  }
}

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
  // The rumor `id`/`created_at` are UNSIGNED (inside the encrypted layer) — the
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

export class NostrMessagingProvider implements MessagingProvider {
  readonly kind = 'nostr';
  private pool = new SimplePool();
  /** Relays we've touched, so `close()` can release them. */
  private relaysSeen = new Set<string>();

  private async publish(relays: string[], event: Parameters<SimplePool['publish']>[1]): Promise<void> {
    relays.forEach((r) => this.relaysSeen.add(r));
    const results = await Promise.allSettled(this.pool.publish(relays, event));
    if (!results.some((r) => r.status === 'fulfilled')) {
      throw new Error('failed to publish to any relay');
    }
  }

  async sendDm({
    identity,
    recipientPubkeyHex,
    text,
    relays,
  }: {
    identity: NostrIdentity;
    recipientPubkeyHex: string;
    text: string;
    relays: string[];
  }): Promise<void> {
    const giftWrap = wrapEvent(identity.privateKey, { publicKey: recipientPubkeyHex }, text);
    await this.publish(relays, giftWrap);
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
          // seal/rumor author mismatch (impersonation) — see unwrapDmSecurely.
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
