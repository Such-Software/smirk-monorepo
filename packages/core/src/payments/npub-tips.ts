/**
 * Tips to an npub over NIP-17 gift wraps.
 *
 * A tip to an npub is an ordinary public tip whose claim key travels inside a
 * gift wrap instead of a share link. The sender funds the single-use tip
 * address exactly as for a link tip; the backend stores the sealed key and
 * `sha256(claimKey)` exactly as for a link tip; the only difference is who can
 * read the key. The relay sees kind-1059 ciphertext addressed to the recipient,
 * so neither the relay nor the backend learns who received the tip.
 *
 * The sender also wraps a copy to their own pubkey carrying `to`. That copy is
 * the sender's history: there is no server-side record of the recipient, and
 * none is needed.
 *
 * Gift-wrap content is attacker-controlled. Anyone can wrap a "tip" with any
 * amount to any npub. Callers MUST treat `asset` and `amount` here as claims
 * and display the backend's record for `tipId` instead, dropping any tip the
 * backend does not know. {@link readNpubTips} returns the claims; it does not
 * vouch for them.
 *
 * Relay I/O is injected ({@link NostrChannelIO}) so this stays unit-testable.
 */

import { decodeUrlFragmentKey, decryptPublicTipPayload } from '../crypto';
import { wrapPayment, unwrapPayment } from '../nostr/giftwrap';
import { GIFT_WRAP_KIND, type TipPayload } from '../nostr/payments';
import type { NostrChannelIO } from './slatepack-channel';

/** What the sender hands over to deliver one claimable tip. */
export interface NpubTipDelivery {
  tipId: string;
  claimKey: string;
  asset: string;
  /** Atomic units, as the backend records them. */
  amount: number;
  memo?: string;
  /** Unix seconds after which the sender may reclaim. */
  expiresAt?: number;
}

/** A claimable tip found in our gift-wrap stream. */
export interface NpubTip {
  direction: 'received' | 'sent';
  tipId: string;
  claimKey: string;
  /** As claimed by the gift wrap. Verify against the backend before showing. */
  asset: string;
  amount: number;
  memo?: string;
  expiresAt?: number;
  /** The other party: the sender for a received tip, the recipient for a sent one. */
  counterpartyHex: string;
  /** Rumor time (unix seconds); seal and wrap times are decoy-randomized. */
  createdAt: number;
}

export interface NpubTipDeliveryResult {
  /** False when the self-addressed history copy failed. The tip itself was
   *  delivered; only the sender's own history entry is missing. */
  selfCopy: boolean;
}

function tipPayload(d: NpubTipDelivery, to?: string): TipPayload {
  return {
    type: 'tip',
    v: 1,
    asset: d.asset,
    amount: d.amount,
    tipId: d.tipId,
    claimKey: d.claimKey,
    ...(d.memo ? { memo: d.memo } : {}),
    ...(d.expiresAt ? { expiresAt: d.expiresAt } : {}),
    ...(to ? { to } : {}),
  };
}

/**
 * Deliver a claimable tip to `recipientPubkeyHex`, then a history copy to
 * ourselves. Delivery to the recipient throws on failure; the self copy is
 * best effort and reported in the result, so a history hiccup never makes a
 * delivered tip look undelivered.
 */
export async function deliverNpubTip(
  io: NostrChannelIO,
  recipientPubkeyHex: string,
  tip: NpubTipDelivery,
): Promise<NpubTipDeliveryResult> {
  const recipient = recipientPubkeyHex.toLowerCase();
  const wrap = wrapPayment(io.identity, recipient, tipPayload(tip));
  await io.publish(await io.outboundRelays(recipient), wrap);

  const self = io.identity.pubkeyHex;
  if (recipient === self) return { selfCopy: true };
  try {
    const copy = wrapPayment(io.identity, self, tipPayload(tip, recipient));
    await io.publish(await io.inboxRelays(), copy);
    return { selfCopy: true };
  } catch {
    return { selfCopy: false };
  }
}

/**
 * True iff `claimKey` opens the backend's sealed tip key (`encrypted_key` from
 * the public tip info). The seal is XChaCha20-Poly1305, so a wrong key fails
 * authentication: this proves a gift wrap's key belongs to that tip, which a
 * forged wrap cannot fake. Never throws.
 */
export function verifyNpubTipKey(encryptedKeyHex: string | null | undefined, claimKey: string): boolean {
  if (!encryptedKeyHex) return false;
  try {
    decryptPublicTipPayload(encryptedKeyHex, decodeUrlFragmentKey(claimKey));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read every claimable tip addressed to us: tips others sent us (`received`)
 * and our own history copies (`sent`). Deduplicated by direction and tip id,
 * newest first. Gift wraps that are not for us, are not tips, or lack a claim
 * key are skipped.
 */
export async function readNpubTips(
  io: NostrChannelIO,
): Promise<{ received: NpubTip[]; sent: NpubTip[] }> {
  const self = io.identity.pubkeyHex;
  const wraps = await io.query(await io.inboxRelays(), [
    { kinds: [GIFT_WRAP_KIND], '#p': [self] },
  ]);

  // Received tips are keyed by tip id AND claim key: a forged wrap that reuses
  // a real tip id with a wrong key must not shadow the genuine one. The caller
  // keeps whichever candidate {@link verifyNpubTipKey} accepts. Sent copies
  // are sealed by our own key, so one per tip id is enough.
  const received = new Map<string, NpubTip>();
  const sent = new Map<string, NpubTip>();
  for (const wrap of wraps) {
    let opened;
    try {
      opened = unwrapPayment(io.identity, wrap);
    } catch {
      continue;
    }
    const p = opened.payload;
    if (p.type !== 'tip' || !p.tipId || !p.claimKey) continue;

    const fromSelf = opened.senderPubkeyHex === self;
    let direction: NpubTip['direction'];
    let counterpartyHex: string;
    if (fromSelf && p.to) {
      direction = 'sent';
      counterpartyHex = p.to;
    } else if (!fromSelf) {
      direction = 'received';
      counterpartyHex = opened.senderPubkeyHex;
    } else {
      continue; // a self-wrapped tip with no recipient carries no history
    }

    const tip: NpubTip = {
      direction,
      tipId: p.tipId,
      claimKey: p.claimKey,
      asset: p.asset,
      amount: p.amount,
      ...(p.memo ? { memo: p.memo } : {}),
      ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
      counterpartyHex,
      createdAt: opened.rumorCreatedAt,
    };
    const bucket = direction === 'sent' ? sent : received;
    const key = direction === 'sent' ? p.tipId : `${p.tipId}:${p.claimKey}`;
    const prev = bucket.get(key);
    if (!prev || tip.createdAt > prev.createdAt) bucket.set(key, tip);
  }
  const newest = (a: NpubTip, b: NpubTip) => b.createdAt - a.createdAt;
  return {
    received: [...received.values()].sort(newest),
    sent: [...sent.values()].sort(newest),
  };
}
