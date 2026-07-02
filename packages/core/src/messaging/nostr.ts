/**
 * Nostr MessagingProvider — the default adapter.
 *
 * NIP-17 private DMs over NIP-59 gift-wrap, using nostr-tools' vetted `nip17`
 * (which builds the kind-14 rumor, seals it kind-13, gift-wraps it kind-1059, and
 * — critically for cross-wallet/Goblin interop — binds + verifies the seal author
 * to the rumor author). Relay I/O via `SimplePool` (browser global WebSocket).
 */

import { SimplePool } from 'nostr-tools/pool';
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip17';
import { finalizeEvent } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';

import type { NostrIdentity } from '../nostr';
import type { MessagingProvider } from './provider';
import type { DirectMessage, DmSubscription } from './types';

/** NIP-59 gift-wrap. */
const GIFT_WRAP_KIND = 1059;
/** NIP-17 DM-inbox relay list. */
const DM_RELAY_LIST_KIND = 10050;

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
        onevent: (evt: { id?: string }) => {
          try {
            // unwrapEvent verifies the seal author == rumor author; on any
            // decrypt failure / mismatch / not-for-us it throws → skipped.
            const rumor = unwrapEvent(evt as never, identity.privateKey);
            onMessage({
              id: rumor.id ?? evt.id ?? '',
              fromPubkeyHex: rumor.pubkey,
              fromNpub: npubEncode(rumor.pubkey),
              text: rumor.content,
              createdAt: rumor.created_at,
            });
          } catch {
            /* malformed / not for us / bad seal — skip */
          }
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
