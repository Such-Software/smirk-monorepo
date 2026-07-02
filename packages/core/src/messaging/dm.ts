/**
 * High-level DM flow — thin convenience over the active provider + relay set, so
 * shells call `sendDm` / `subscribeDms` without threading relays through.
 */

import { decodeNpub, type NostrIdentity } from '../nostr';
import { messagingProvider, messagingRelays } from './registry';
import type { DirectMessage, DmSubscription } from './types';

/** Accept an npub (bech32) or a raw x-only hex; return x-only hex. */
export function recipientToHex(recipient: string): string {
  const r = recipient.trim();
  if (r.startsWith('npub1')) {
    return Array.from(decodeNpub(r))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  if (/^[0-9a-fA-F]{64}$/.test(r)) return r.toLowerCase();
  throw new Error('recipient must be an npub or 64-char hex pubkey');
}

/** Send a direct message to an npub or hex pubkey over the active relay set. */
export async function sendDm(
  identity: NostrIdentity,
  recipient: string,
  text: string,
): Promise<void> {
  await messagingProvider().sendDm({
    identity,
    recipientPubkeyHex: recipientToHex(recipient),
    text,
    relays: messagingRelays(),
  });
}

/** Subscribe to incoming DMs for `identity`, delivering each to `onMessage`. */
export function subscribeDms(
  identity: NostrIdentity,
  onMessage: (dm: DirectMessage) => void,
): DmSubscription {
  return messagingProvider().subscribeDms({
    identity,
    relays: messagingRelays(),
    onMessage,
  });
}

/** Advertise the active relay set as our NIP-17 DM inbox (kind 10050). */
export async function publishDmInbox(identity: NostrIdentity): Promise<void> {
  await messagingProvider().publishDmRelayList({
    identity,
    relays: messagingRelays(),
    inboxRelays: messagingRelays(),
  });
}
