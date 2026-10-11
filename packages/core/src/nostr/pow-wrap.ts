/**
 * NIP-59 gift wrap with NIP-13 proof-of-work on the outer event.
 *
 * A gift wrap is signed by a fresh ephemeral key, so to the relay EVERY wrap is
 * from an unknown author, even one a registered user sends to a neighbour on
 * the same relay. Relays that gate unknown authors behind proof-of-work (ours
 * advertises `messaging.inbound_pow_bits`) therefore refuse any wrap that does
 * not carry it. DMs, tips and Grin slatepacks all ride this one envelope, so
 * they all need it.
 *
 * nostr-tools' `minePow` is not usable here. It resets `created_at` to the
 * current second on every iteration, and NIP-59 deliberately BACKDATES the wrap
 * by a random interval so the timestamp cannot be correlated with when you
 * actually sent it. Mining with it would buy relay admission by leaking send
 * time. Only the nonce varies here; the randomised timestamp survives.
 *
 * 8 bits averages 256 hashes, which is imperceptible. The cost is exponential
 * in the bit count, so a relay demanding a large difficulty will be slow by
 * design, and the caller decides whether that is worth it.
 */

import { createSeal } from 'nostr-tools/nip59';
import { encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import { getPow } from 'nostr-tools/nip13';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure';

const GIFT_WRAP_KIND = 1059;

/** Wrap an already-built seal for `recipientPublicKey`, mining `difficulty` leading zero bits. */
export function wrapSealWithPow(
  sealed: ReturnType<typeof createSeal>,
  recipientPublicKey: string,
  difficulty: number,
): ReturnType<typeof finalizeEvent> {
  const ephemeral = generateSecretKey();
  // Same shape nostr-tools' createWrap produces, including NIP-59's backdated timestamp.
  const base = {
    kind: GIFT_WRAP_KIND,
    content: nip44Encrypt(JSON.stringify(sealed), getConversationKey(ephemeral, recipientPublicKey)),
    created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800),
    pubkey: getPublicKey(ephemeral),
  };
  if (difficulty <= 0) {
    const { pubkey: _drop, ...rest } = base;
    return finalizeEvent({ ...rest, tags: [['p', recipientPublicKey]] }, ephemeral);
  }
  const tags: string[][] = [
    ['p', recipientPublicKey],
    ['nonce', '0', String(difficulty)],
  ];
  const nonceTag = tags[1]!;
  for (let count = 1; ; count++) {
    nonceTag[1] = String(count);
    if (getPow(getEventHash({ ...base, tags })) >= difficulty) break;
  }
  const { pubkey: _drop, ...rest } = base;
  // finalizeEvent recomputes the id over these exact bytes, so the mined id is the one that ships.
  return finalizeEvent({ ...rest, tags }, ephemeral);
}
