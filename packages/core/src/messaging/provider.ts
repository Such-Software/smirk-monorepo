/**
 * MessagingProvider seam — the messaging plane (identity + encrypted delivery),
 * parallel to the ChainProvider seam. Nostr is the default (and interop
 * standard), but the wallet talks to this interface, so another relay backend or
 * a different messaging protocol can be swapped in without touching callers.
 */

import type { NostrIdentity } from '../nostr';
import type { DirectMessage, DmSubscription, GiftWrapEvent } from './types';

export interface MessagingProvider {
  /** Adapter kind, e.g. `nostr`. */
  readonly kind: string;

  /** Send an encrypted direct message to `recipientPubkeyHex` over `relays`. */
  sendDm(params: {
    identity: NostrIdentity;
    recipientPubkeyHex: string;
    text: string;
    relays: string[];
  }): Promise<void>;

  /**
   * Subscribe to incoming direct messages for `identity` on `relays`. Each
   * decrypted message is delivered to `onMessage`; malformed/undecryptable
   * envelopes are skipped. Returns a handle to stop the subscription.
   */
  subscribeDms(params: {
    identity: NostrIdentity;
    relays: string[];
    onMessage: (dm: DirectMessage) => void;
  }): DmSubscription;

  /**
   * Fetch (poll) the raw, still-ENCRYPTED gift-wraps addressed to `pubkeyHex` —
   * a one-shot query (not a live subscription). The background poller uses this
   * without the private key (collecting wraps needs only the public npub); the
   * caller decrypts later. `sinceSec` bounds the window.
   */
  queryDmWraps(params: {
    pubkeyHex: string;
    relays: string[];
    sinceSec?: number | undefined;
  }): Promise<GiftWrapEvent[]>;

  /**
   * Read a recipient's DM-inbox relay list (NIP-17 / kind 10050) — the `relay`
   * tags of their latest kind-10050 event. Used to route a DM to where the
   * recipient actually reads (cross-wallet delivery). Empty if they publish none.
   */
  queryDmRelayList(params: { pubkeyHex: string; relays: string[] }): Promise<string[]>;

  /**
   * Publish our DM-inbox relay list (NIP-17 / kind 10050) so senders know where
   * to deliver — advertising `inboxRelays` as our preferred inbox.
   */
  publishDmRelayList(params: {
    identity: NostrIdentity;
    relays: string[];
    inboxRelays: string[];
  }): Promise<void>;

  /** Release relay connections. */
  close(): void;
}
