/**
 * Inbox respond/cancel routing (P3b). An inbox row is either a backend-relay
 * slatepack or a Nostr gift-wrap one; its `relayId` (see relay-ref.ts) says which.
 * These helpers pick the transport and address the action correctly — a Nostr
 * respond/cancel gift-wraps back to the original counterparty, a backend one hits
 * `/wallet/grin/relay/*`. Shared by the sign handler (index.tsx) and the Inbox
 * cancel button (routes/inbox.tsx).
 */

import { api, buildSlatepackChannels, deriveNostrIdentity } from '@smirk/core';

import { parseRelayRef } from './relay-ref';

function channelsFor(userId: string, mnemonic: string) {
  const identity = deriveNostrIdentity(mnemonic, 0);
  return buildSlatepackChannels({ grin: api, userId, identity });
}

/** Deliver the S2 response for an inbox item over its transport. Returns
 *  `{ error }` on failure (never throws) so callers can surface it. */
export async function respondToInboxItem(params: {
  relayId: string;
  s2Armored: string;
  userId: string;
  mnemonic: string;
}): Promise<{ error?: string }> {
  const ref = parseRelayRef(params.relayId);
  try {
    const channels = channelsFor(params.userId, params.mnemonic);
    if (ref.channel === 'nostr') {
      await channels.nostr.respond(ref.slateId, params.s2Armored, ref.counterparty);
    } else {
      await channels.backend.respond(ref.relayId, params.s2Armored);
    }
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to deliver response' };
  }
}

/** Cancel/abandon an inbox item over its transport. */
export async function cancelInboxItem(params: {
  relayId: string;
  userId: string;
  mnemonic: string;
}): Promise<{ error?: string }> {
  const ref = parseRelayRef(params.relayId);
  try {
    const channels = channelsFor(params.userId, params.mnemonic);
    if (ref.channel === 'nostr') {
      await channels.nostr.cancel(ref.slateId, ref.counterparty);
    } else {
      await channels.backend.cancel(ref.relayId);
    }
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to cancel' };
  }
}
