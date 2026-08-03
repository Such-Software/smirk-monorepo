/**
 * Runtime {@link NostrChannelIO} for {@link NostrGiftwrapChannel}: the bridge
 * from the pure P3a seam to real relays. Payments share the gift-wrap inbox with
 * DMs (identical kind-1059 rail), so this reuses the messaging plane verbatim:
 * the same relay resolution that already targets a recipient's kind-10050 inbox
 * (Goblin users included) and the same seedless wrap poll the background poller
 * uses. No new relay code, just glue.
 */

import type { NostrIdentity } from '../nostr';
import type { NostrWireEvent, NostrFilter } from '../nostr/client';
import { messagingProvider, messagingRelays } from '../messaging/registry';
import { resolveDmRelays } from '../messaging/dm';
import type { GiftWrapEvent } from '../messaging/types';
import type { NostrChannelIO } from './slatepack-channel';

const dedup = (a: string[]): string[] => [...new Set(a.filter(Boolean))];

/**
 * Build the runtime relay I/O for the Nostr payment channel, bound to `identity`
 * (the npub we sign under + read our inbox by). Delivery targets a recipient's
 * DM-inbox relays (their kind-10050 ∪ ours) so payments reach non-Smirk wallets;
 * our own inbox is polled off the active relay set.
 */
export function createNostrChannelIO(identity: NostrIdentity): NostrChannelIO {
  return {
    identity,

    async publish(relays: string[], event: NostrWireEvent): Promise<void> {
      await messagingProvider().publishWrap({ wrap: event as unknown as GiftWrapEvent, relays });
    },

    async query(relays: string[], filters: NostrFilter[]): Promise<NostrWireEvent[]> {
      // The channel only ever asks for kind-1059 wraps addressed to us; delegate
      // to the provider's seedless poll (needs the public npub only).
      const sinceSec = filters.map((f) => f.since).find((s): s is number => typeof s === 'number');
      const wraps = await messagingProvider().queryDmWraps({
        pubkeyHex: identity.pubkeyHex,
        relays,
        sinceSec,
      });
      return wraps as unknown as NostrWireEvent[];
    },

    async outboundRelays(recipientPubkeyHex: string): Promise<string[]> {
      const { relays } = await resolveDmRelays(recipientPubkeyHex);
      // Publish where they read PLUS our own relay, so a copy lands in our inbox.
      const out = dedup([...relays, ...messagingRelays()]);
      // Publishing to zero relays silently "succeeds" and the payment simply
      // never arrives. This used to be masked by a hardcoded fallback to
      // third-party relays; now that the wallet only talks to relays the
      // operator (or user) chose, an empty set has to be a legible error.
      if (!out.length) {
        throw new Error(
          'No Nostr relay is configured for this backend, so the payment cannot be delivered. ' +
            'Ask the operator to enable a relay, or use another transport.',
        );
      }
      return out;
    },

    async inboxRelays(): Promise<string[]> {
      return messagingRelays();
    },
  };
}
