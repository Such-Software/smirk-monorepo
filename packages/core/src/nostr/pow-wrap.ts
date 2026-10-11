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
 * 8 bits averages 256 hashes, which is imperceptible. The cost doubles with
 * every bit and the loop runs synchronously on the caller's thread, so the
 * difficulty is bounded by {@link MAX_WRAP_POW_BITS}.
 */

import { createSeal } from 'nostr-tools/nip59';
import { encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import { getPow } from 'nostr-tools/nip13';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure';

const GIFT_WRAP_KIND = 1059;

/**
 * The most proof-of-work the wallet mines on one wrap. At the tens of thousands
 * of hashes a second a wallet manages, 8 bits takes milliseconds, 16 about a
 * second, 20 tens of seconds and 32 over a day, with the wallet frozen
 * throughout. The relay guide recommends 8 to 16 bits for a public relay; the
 * backend accepts up to 40. A demand above this ceiling is refused before any
 * hashing, naming the figure, instead of hanging the wallet only to be refused.
 */
export const MAX_WRAP_POW_BITS = 20;

/** Wrap an already-built seal for `recipientPublicKey`, mining `difficulty` leading zero bits. */
export function wrapSealWithPow(
  sealed: ReturnType<typeof createSeal>,
  recipientPublicKey: string,
  difficulty: number,
): ReturnType<typeof finalizeEvent> {
  // Callers pass a backend-advertised figure. A NaN would never satisfy the
  // loop below, and an excessive one would freeze the wallet: refuse both now.
  if (!Number.isInteger(difficulty)) {
    throw new Error(`the relay's proof-of-work difficulty is not a whole number of bits (${String(difficulty)})`);
  }
  if (difficulty > MAX_WRAP_POW_BITS) {
    throw new Error(
      `the relay requires ${difficulty} bits of proof-of-work per message; this wallet mines at most ${MAX_WRAP_POW_BITS}`,
    );
  }
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
