/**
 * High-level DM flow — thin convenience over the active provider + relay set, so
 * shells call `sendDm` / `subscribeDms` without threading relays through.
 */

import { decodeNpub, resolveNip05, type NostrIdentity } from '../nostr';
import { messagingProvider, messagingRelays } from './registry';
import { wrapToDirectMessage } from './nostr';
import type { DirectMessage, DmSubscription, GiftWrapEvent } from './types';

const dedup = (a: string[]): string[] => [...new Set(a.filter(Boolean))];

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

/**
 * Resolve a recipient (npub, hex, or `name@domain`) to their x-only pubkey + the
 * relays to DELIVER to: their NIP-17 DM inbox (kind 10050), falling back to their
 * NIP-05 relay hints, then the public interop relays. This is what makes DMs
 * reach non-Smirk (e.g. Goblin) users — you must publish where they read.
 */
export async function resolveDmRelays(
  recipient: string,
): Promise<{ pubkeyHex: string; relays: string[] }> {
  let pubkeyHex: string;
  let hintRelays: string[] = [];
  if (recipient.includes('@')) {
    const r = await resolveNip05(recipient);
    if (!r.ok) throw new Error(`could not resolve ${recipient}: ${r.error}`);
    pubkeyHex = r.resolution.pubkeyHex;
    hintRelays = r.resolution.relays ?? [];
  } else {
    pubkeyHex = recipientToHex(recipient);
  }
  // Look for their kind-10050 across their hint relays + whatever we are
  // configured to use. `DEFAULT_PUBLIC_RELAYS` is deliberately NOT appended:
  // unconditionally querying damus/nos.lol leaked who the user is looking up,
  // on an instance whose operator may run no third-party relays at all. The
  // recipient's own NIP-05 hints already carry cross-wallet reachability.
  const lookupRelays = dedup([...hintRelays, ...messagingRelays()]);
  let inbox: string[] = [];
  try {
    inbox = await messagingProvider().queryDmRelayList({ pubkeyHex, relays: lookupRelays });
  } catch {
    /* no kind-10050 / unreachable — fall back to the NIP-05 hints */
  }
  // Same reasoning for the fallback: if we resolved nothing, say so. Silently
  // substituting third-party relays sends the gift-wrap somewhere the operator
  // never sanctioned, and the caller cannot tell that it happened.
  const relays = dedup([...inbox, ...hintRelays, ...messagingRelays()]);
  return { pubkeyHex, relays };
}

/**
 * Send a direct message to a recipient (npub, hex, or `name@domain`). Resolves
 * their inbox relays and publishes there PLUS our own relay (so a copy lands
 * where we read too).
 */
export async function sendDm(
  identity: NostrIdentity,
  recipient: string,
  text: string,
): Promise<void> {
  const { pubkeyHex, relays } = await resolveDmRelays(recipient);
  const deliveryRelays = dedup([...relays, ...messagingRelays()]);
  await messagingProvider().sendDm({
    identity,
    recipientPubkeyHex: pubkeyHex,
    text,
    relays: deliveryRelays,
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

/**
 * Poll the active relays for raw (encrypted) gift-wraps addressed to `pubkeyHex`
 * — needs only the PUBLIC npub, so the background service worker calls this
 * without the seed. Decrypt later with [`decryptWrap`] in an unlocked context.
 */
export async function fetchDmWraps(
  pubkeyHex: string,
  sinceSec?: number,
): Promise<GiftWrapEvent[]> {
  return messagingProvider().queryDmWraps({ pubkeyHex, relays: messagingRelays(), sinceSec });
}

/** Verifying-decrypt a stored gift-wrap into a display message, or null. */
export function decryptWrap(identity: NostrIdentity, wrap: GiftWrapEvent): DirectMessage | null {
  return wrapToDirectMessage(wrap, identity.privateKey);
}
