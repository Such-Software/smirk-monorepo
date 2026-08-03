/**
 * NIP-59 gift-wrap for payment payloads (P3, the Goblin convergence).
 *
 * Wraps a {@link PaymentPayload} as: kind-14 rumor → kind-13 seal (NIP-44 to the
 * recipient, signed by the sender) → kind-1059 gift-wrap (NIP-44 under a fresh
 * EPHEMERAL key, so the outer event reveals neither sender nor content, only a
 * `p` tag routing it to the recipient). This is the exact envelope Goblin uses
 * for its kind-14 rumor Grin delivery, so a wrap Smirk publishes is one Goblin
 * can open, and vice-versa.
 *
 * The heavy lifting (seal + ephemeral wrap + NIP-44 v2) is nostr-tools' `nip59`;
 * this module only maps our identity/wire types and layers the payment schema on
 * top. `wrapEvent` uses `Date.now()`/`Math.random()` for the decoy timestamps +
 * ephemeral key: fine in the wallet runtime; round-trips are deterministic in
 * outcome even though the wrapper bytes differ each call.
 */

import { wrapEvent } from 'nostr-tools/nip59';
import { decrypt as nip44Decrypt, getConversationKey } from 'nostr-tools/nip44';
import { verifyEvent } from 'nostr-tools/pure';

import type { NostrIdentity } from './identity';
import type { NostrWireEvent } from './client';
import { buildPaymentRumor, parsePaymentPayload, PAYMENT_RUMOR_KIND, type PaymentPayload } from './payments';

/** NIP-59 seal kind (signed by the real sender). */
const SEAL_KIND = 13;

/**
 * Securely open a NIP-59 gift-wrap: decrypt both layers, REQUIRE a validly-signed
 * kind-13 seal, and enforce `seal.pubkey === rumor.pubkey`. nostr-tools'
 * `unwrapEvent` (2.23.x) does NEITHER: it only decrypts, so its returned `pubkey`
 * is attacker-controllable (a random ephemeral key can wrap a rumor claiming ANY
 * npub as author → sender impersonation). For a payment that is a real attack: you
 * would respond to, or credit a tip to, the wrong counterparty. This is the shared
 * anti-impersonation check for both DMs and payments; returns the authenticated
 * kind-14 rumor, or null on any failure.
 */
export function unwrapRumorSecurely(
  wrap: { pubkey: string; content: string; id?: string },
  recipientSk: Uint8Array,
): { pubkey: string; content: string; created_at: number; id?: string } | null {
  try {
    // Layer 1: gift-wrap (1059) → seal, via the wrap's ephemeral key.
    const seal = JSON.parse(nip44Decrypt(wrap.content, getConversationKey(recipientSk, wrap.pubkey)));
    // The seal MUST be a validly self-signed kind-13 (proves seal.pubkey signed it).
    if (seal?.kind !== SEAL_KIND || !verifyEvent(seal)) return null;
    // Layer 2: seal → rumor, via the now-authenticated seal author key.
    const rumor = JSON.parse(nip44Decrypt(seal.content, getConversationKey(recipientSk, seal.pubkey)));
    if (rumor?.kind !== PAYMENT_RUMOR_KIND || typeof rumor.content !== 'string') return null;
    // The check nostr-tools omits: the claimed sender IS the seal signer.
    if (rumor.pubkey !== seal.pubkey) return null;
    return rumor;
  } catch {
    return null;
  }
}

/** A gift-wrap addressed to a recipient: a kind-1059 wire event. */
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
  /** The sender's real x-only pubkey hex (the seal author, authenticated). */
  senderPubkeyHex: string;
  payload: PaymentPayload;
  /** The rumor's own timestamp (may be decoy-randomized by the sender). */
  rumorCreatedAt: number;
}

/**
 * Open a gift-wrap addressed to `recipient` and parse its payment payload.
 * Throws if the wrap isn't decryptable by this identity or the inner content
 * isn't a recognized payment; callers treat a throw as "not for us / not a
 * payment" and skip it.
 */
export function unwrapPayment(
  recipient: NostrIdentity,
  wrap: PaymentGiftWrap,
): UnwrappedPayment {
  const rumor = unwrapRumorSecurely(wrap, recipient.privateKey);
  if (!rumor) throw new Error('gift-wrap failed the authenticated unwrap (bad seal or impersonation)');
  return {
    senderPubkeyHex: rumor.pubkey,
    payload: parsePaymentPayload(rumor.content),
    rumorCreatedAt: rumor.created_at,
  };
}
