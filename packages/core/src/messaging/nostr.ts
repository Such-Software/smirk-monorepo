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
import type { DirectMessage, DmSubscription } from './types';

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
          const rumor = unwrapDmSecurely(evt, identity.privateKey);
          if (!rumor) return;
          onMessage({
            id: rumor.id ?? evt.id ?? '',
            fromPubkeyHex: rumor.pubkey,
            fromNpub: npubEncode(rumor.pubkey),
            text: rumor.content,
            createdAt: rumor.created_at,
          });
        },
      },
    );
    return { close: () => sub.close() };
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
