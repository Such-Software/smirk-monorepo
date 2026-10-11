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
 * The claim key is a bearer secret (whoever holds it can sweep the tip), so it
 * never sits in the rumor in the clear. It is sealed again, inside the rumor,
 * under {@link claimSealKey}: HKDF over the sender/recipient ECDH x-coordinate
 * with its own salt and the tip id. That matters because the wallet lends this
 * same Nostr key to websites through NIP-07, and a site granted
 * `nip44.decrypt` can open the gift wrap and the seal exactly as we do. NIP-44
 * derives with salt `nip44-v2` and NIP-04 uses the raw x-coordinate as an AES
 * key; neither oracle yields an HMAC under another salt, so a site that reads
 * the rumor learns the tip id and amount but not the key. Any other NIP-17
 * client holding the nsec shows the same rumor as a chat message, which is the
 * second reason the key must not be readable there.
 *
 * Gift-wrap content is attacker-controlled. Anyone can wrap a "tip" with any
 * amount to any npub. Callers MUST treat `asset` and `amount` here as claims
 * and display the backend's record for `tipId` instead, dropping any tip the
 * backend does not know. {@link readNpubTips} returns the claims; it does not
 * vouch for them.
 *
 * Relay I/O is injected ({@link NostrChannelIO}) so this stays unit-testable.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { decodeUrlFragmentKey, decrypt, decryptPublicTipPayload, encrypt } from '../crypto';
import { wrapPayment, unwrapPayment } from '../nostr/giftwrap';
import { GIFT_WRAP_KIND, type TipPayload } from '../nostr/payments';
import type { NostrChannelIO } from './slatepack-channel';

/** Domain separator for the inner claim-key seal. Never `nip44-v2`. */
const CLAIM_SEAL_LABEL = 'smirk-tip-claim-v1';

/**
 * The key that seals a tip's claim key between two Nostr identities.
 *
 * `HKDF-SHA256(ikm = x(ECDH(ourKey, peer)), salt = "smirk-tip-claim-v1",
 * info = "smirk-tip-claim-v1:" + tipId)`. ECDH on x-only keys is symmetric
 * (the x-coordinate of `a*B` equals that of `b*A` for either lift of the
 * x-only keys), so the sender, sealing to the recipient, and the recipient,
 * opening from the authenticated seal author, derive the same key. The
 * sender's self copy uses its own pubkey as the peer. Binding the tip id means
 * a sealed key cannot be lifted onto another tip's id.
 */
function claimSealKey(privateKey: Uint8Array, peerPubkeyHex: string, tipId: string): Uint8Array {
  const shared = secp256k1.getSharedSecret(privateKey, `02${peerPubkeyHex.toLowerCase()}`);
  const x = shared.slice(1, 33);
  try {
    const enc = new TextEncoder();
    return hkdf(sha256, x, enc.encode(CLAIM_SEAL_LABEL), enc.encode(`${CLAIM_SEAL_LABEL}:${tipId.toLowerCase()}`), 32);
  } finally {
    shared.fill(0);
    x.fill(0);
  }
}

/** Seal `claimKey` for `peerPubkeyHex` (the recipient, or ourselves for the history copy). */
export function sealNpubTipClaimKey(
  privateKey: Uint8Array,
  peerPubkeyHex: string,
  tipId: string,
  claimKey: string,
): string {
  const key = claimSealKey(privateKey, peerPubkeyHex, tipId);
  try {
    return bytesToHex(encrypt(new TextEncoder().encode(claimKey), key));
  } finally {
    key.fill(0);
  }
}

/**
 * Open a sealed claim key from `peerPubkeyHex` (the authenticated seal author).
 * Returns null when it does not open: a forged or mismatched wrap.
 */
export function openNpubTipClaimKey(
  privateKey: Uint8Array,
  peerPubkeyHex: string,
  tipId: string,
  sealedHex: string,
): string | null {
  let key: Uint8Array | null = null;
  try {
    key = claimSealKey(privateKey, peerPubkeyHex, tipId);
    const claimKey = new TextDecoder().decode(decrypt(hexToBytes(sealedHex), key));
    // The share-link fragment shape, as `generateUrlFragmentKey` encodes it.
    return /^[A-Za-z0-9_-]{20,128}$/.test(claimKey) ? claimKey : null;
  } catch {
    return null;
  } finally {
    key?.fill(0);
  }
}

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

function tipPayload(sealedClaimKey: string, d: NpubTipDelivery, to?: string): TipPayload {
  return {
    type: 'tip',
    v: 1,
    asset: d.asset,
    amount: d.amount,
    tipId: d.tipId,
    sealedClaimKey,
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
  const sealFor = (peer: string) => sealNpubTipClaimKey(io.identity.privateKey, peer, tip.tipId, tip.claimKey);
  const powBits = (await io.powBits?.()) ?? 0;
  const wrap = wrapPayment(io.identity, recipient, tipPayload(sealFor(recipient), tip), powBits);
  await io.publish(await io.outboundRelays(recipient), wrap);

  const self = io.identity.pubkeyHex;
  if (recipient === self) return { selfCopy: true };
  try {
    const copy = wrapPayment(io.identity, self, tipPayload(sealFor(self), tip, recipient), powBits);
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
    if (p.type !== 'tip' || !p.tipId || !p.sealedClaimKey) continue;
    // Sealed between us and the authenticated seal author (ourselves for a
    // history copy). A wrap that does not open is not a tip we can claim.
    const claimKey = openNpubTipClaimKey(io.identity.privateKey, opened.senderPubkeyHex, p.tipId, p.sealedClaimKey);
    if (!claimKey) continue;

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
      claimKey,
      asset: p.asset,
      amount: p.amount,
      ...(p.memo ? { memo: p.memo } : {}),
      ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
      counterpartyHex,
      createdAt: opened.rumorCreatedAt,
    };
    const bucket = direction === 'sent' ? sent : received;
    const key = direction === 'sent' ? p.tipId : `${p.tipId}:${claimKey}`;
    const prev = bucket.get(key);
    if (!prev || tip.createdAt > prev.createdAt) bucket.set(key, tip);
  }
  const newest = (a: NpubTip, b: NpubTip) => b.createdAt - a.createdAt;
  return {
    received: [...received.values()].sort(newest),
    sent: [...sent.values()].sort(newest),
  };
}
