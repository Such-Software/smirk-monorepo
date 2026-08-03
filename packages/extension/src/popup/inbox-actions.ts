/**
 * Inbox respond/cancel routing (P3b). An inbox row is either a backend-relay
 * slatepack or a Nostr gift-wrap one; its `relayId` (see relay-ref.ts) says which.
 * These helpers pick the transport and address the action correctly: a Nostr
 * respond/cancel gift-wraps back to the original counterparty, a backend one hits
 * `/wallet/grin/relay/*`. Shared by the sign handler (index.tsx) and the Inbox
 * cancel button (routes/inbox.tsx).
 */

import { api, buildSlatepackChannels, type GrinPendingOverlay } from '@smirk/core';

import { parseRelayRef } from './relay-ref';
import { getActiveNostrIdentity } from './nostr-vault';
import { grinOverlay } from './grin-flows';

async function channelsFor(userId: string, mnemonic: string) {
  const identity = await getActiveNostrIdentity(mnemonic);
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
    const channels = await channelsFor(params.userId, params.mnemonic);
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

/**
 * MONEY-CRITICAL: free the reserved inputs of a `pending_to_finalize` inbox row.
 *
 * Such a row is a send we already built (and delivered) but have NOT broadcast;
 * startGrinSend reserved its inputs + change index in the client overlay AT BUILD
 * TIME. Cancelling it from the Inbox must therefore ALSO free those reserved
 * inputs, exactly as the wizard's cancelGrinSend does; otherwise they stay
 * excluded from selection until the 7-day age-out (stuck funds). We free via the
 * overlay's PRE-BROADCAST remove(), which itself refuses to touch a broadcast
 * entry, so a row whose tx already hit the chain (double-spend risk) is never
 * freed. remove() is a no-op when there's no reserved entry (e.g. an
 * incoming-sign row), so it's safe to call for any inbox item.
 *
 * The overlay is injectable for tests; production defaults to the shared
 * `grinOverlay` singleton (NOT a fresh instance) so this free serializes against
 * the always-on ~30s reconcile and any in-flight send; a private overlay would
 * race it and could drop a broadcast-guard flag (double-spend) or lose an update.
 * The overlay's per-storage-key global lock backstops this regardless.
 * The slateId is the backend relayId (a bare slate_id) or the Nostr ref's slateId.
 */
export async function freeInboxReservedInputs(
  relayId: string,
  overlay: GrinPendingOverlay = grinOverlay,
): Promise<void> {
  const ref = parseRelayRef(relayId);
  const slateId = ref.channel === 'nostr' ? ref.slateId : ref.relayId;
  await overlay.remove(slateId).catch(() => undefined);
}

/** Cancel/abandon an inbox item over its transport, freeing any reserved inputs
 *  first (see {@link freeInboxReservedInputs}). */
export async function cancelInboxItem(params: {
  relayId: string;
  userId: string;
  mnemonic: string;
}): Promise<{ error?: string }> {
  const ref = parseRelayRef(params.relayId);
  // Free the reserved inputs first, before the transport cancel, so a transport
  // failure can't leave the inputs wedged until the age-out.
  await freeInboxReservedInputs(params.relayId);
  try {
    const channels = await channelsFor(params.userId, params.mnemonic);
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
