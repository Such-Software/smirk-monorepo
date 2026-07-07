/**
 * NIP-59 gift-wrap for payment payloads (P3, the Goblin convergence).
 *
 * Wraps a {@link PaymentPayload} as: kind-14 rumor → kind-13 seal (NIP-44 to the
 * recipient, signed by the sender) → kind-1059 gift-wrap (NIP-44 under a fresh
 * EPHEMERAL key, so the outer event reveals neither sender nor content — only a
 * `p` tag routing it to the recipient). This is the exact envelope Goblin uses
 * for its kind-14 rumor Grin delivery, so a wrap Smirk publishes is one Goblin
 * can open, and vice-versa.
 *
 * The heavy lifting (seal + ephemeral wrap + NIP-44 v2) is nostr-tools' `nip59`;
 * this module only maps our identity/wire types and layers the payment schema on
 * top. `wrapEvent` uses `Date.now()`/`Math.random()` for the decoy timestamps +
 * ephemeral key — fine in the wallet runtime; round-trips are deterministic in
 * outcome even though the wrapper bytes differ each call.
 */

import { wrapEvent, unwrapEvent } from 'nostr-tools/nip59';

import type { NostrIdentity } from './identity';
import type { NostrWireEvent } from './client';
import { buildPaymentRumor, parsePaymentPayload, type PaymentPayload } from './payments';

/** A gift-wrap addressed to a recipient — a kind-1059 wire event. */
export type PaymentGiftWrap = NostrWireEvent;

/**
 * Gift-wrap `payload` from `sender` to `recipientPubkeyHex` (x-only hex). The
 * returned kind-1059 event is signed by a throwaway key; its only clue to the
 * recipient is the `p` tag.
 */
export function wrapPayment(
  sender: NostrIdentity,
  recipientPubkeyHex: string,
  payload: PaymentPayload,
): PaymentGiftWrap {
  const rumor = buildPaymentRumor(payload, recipientPubkeyHex);
  // nostr-tools types the rumor loosely (an unsigned event template); our
  // UnsignedRumor supplies kind/content/tags, which is all createRumor reads.
  return wrapEvent(
    rumor as unknown as Parameters<typeof wrapEvent>[0],
    sender.privateKey,
    recipientPubkeyHex,
  ) as PaymentGiftWrap;
}

/** The result of opening a gift-wrap: who really sent it (from the inner seal,
 *  which the ephemeral outer layer hides) + the parsed payload. */
export interface UnwrappedPayment {
  /** The sender's real x-only pubkey hex (the seal author — authenticated). */
  senderPubkeyHex: string;
  payload: PaymentPayload;
  /** The rumor's own timestamp (may be decoy-randomized by the sender). */
  rumorCreatedAt: number;
}

/**
 * Open a gift-wrap addressed to `recipient` and parse its payment payload.
 * Throws if the wrap isn't decryptable by this identity or the inner content
 * isn't a recognized payment — callers treat a throw as "not for us / not a
 * payment" and skip it.
 */
export function unwrapPayment(
  recipient: NostrIdentity,
  wrap: PaymentGiftWrap,
): UnwrappedPayment {
  const rumor = unwrapEvent(
    wrap as unknown as Parameters<typeof unwrapEvent>[0],
    recipient.privateKey,
  );
  return {
    senderPubkeyHex: rumor.pubkey,
    payload: parsePaymentPayload(rumor.content),
    rumorCreatedAt: rumor.created_at,
  };
}
