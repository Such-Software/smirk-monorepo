/**
 * Channel construction + the unified inbox read (P3b). One place the app builds
 * both slatepack transports and reads them together, so the extension has a single
 * clean entry point instead of threading channel wiring through every call site.
 */

import type { GrinMethods } from '../api/grin';
import type { NostrIdentity } from '../nostr';
import {
  BackendRelayChannel,
  NostrGiftwrapChannel,
  selectSendChannel,
  type InboundSlatepack,
  type OutboundSlatepack,
  type SlatepackChannel,
} from './slatepack-channel';
import { createNostrChannelIO } from './nostr-channel-io';

export interface SlatepackChannels {
  backend: BackendRelayChannel;
  nostr: NostrGiftwrapChannel;
}

/** Build both transports from the wallet context. `userId` is the backend user
 *  (relay fallback); `identity` is the active npub (gift-wrap default). */
export function buildSlatepackChannels(deps: {
  grin: GrinMethods;
  userId: string;
  identity: NostrIdentity;
}): SlatepackChannels {
  return {
    backend: new BackendRelayChannel({ grin: deps.grin, userId: deps.userId }),
    nostr: new NostrGiftwrapChannel(createNostrChannelIO(deps.identity)),
  };
}

/** Route a send to the right transport (Nostr when npub-addressable, else backend)
 *  and deliver. Thin wrapper over {@link selectSendChannel} for the common case. */
export function sendSlatepack(
  channels: SlatepackChannels,
  recipient: { pubkeyHex?: string; userId?: string },
  msg: OutboundSlatepack,
): Promise<{ id: string }> {
  return selectSendChannel(recipient, channels).deliver(msg);
}

/**
 * Read BOTH inboxes and merge into one pending list for the unified Inbox tab. A
 * slateId present on both transports (e.g. a backend send later mirrored to Nostr)
 * is deduped, preferring the Nostr copy (private + authenticated sender). Each
 * transport is polled independently: one failing (offline relay, backend down)
 * doesn't sink the other.
 */
export async function readAllInbound(channels: SlatepackChannels): Promise<InboundSlatepack[]> {
  const settle = async (ch: SlatepackChannel): Promise<InboundSlatepack[]> => {
    try {
      return await ch.inbox();
    } catch {
      return [];
    }
  };
  const [nostr, backend] = await Promise.all([settle(channels.nostr), settle(channels.backend)]);
  const bySlate = new Map<string, InboundSlatepack>();
  // Backend first, then let Nostr overwrite on a slateId collision.
  for (const item of [...backend, ...nostr]) bySlate.set(item.slateId, item);
  return [...bySlate.values()].sort((a, b) => b.createdAt - a.createdAt);
}
