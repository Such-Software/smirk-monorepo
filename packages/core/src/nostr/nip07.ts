/**
 * NIP-07 (`window.nostr`) crypto — NIP-44 v2 + legacy NIP-04 encrypt/decrypt for
 * the wallet's Nostr identity. These are the operations a dapp (Magick Market, any
 * Nostr client) needs beyond getPublicKey/signEvent: reading + writing encrypted
 * DMs through the wallet. Pure over the identity's private key; the wallet runs
 * them in its unlocked context and NEVER exports the key.
 *
 * NIP-44 v2 is the interop baseline: Goblin negotiates a custom v3 via the
 * kind-10050 `encryption` tag but falls back to v2 for peers that don't advertise
 * v3 (us), so v2 is all we need to interoperate.
 */

import { encrypt as nip44v2Encrypt, decrypt as nip44v2Decrypt, getConversationKey } from 'nostr-tools/nip44';
import { encrypt as nip04v1Encrypt, decrypt as nip04v1Decrypt } from 'nostr-tools/nip04';

import type { NostrIdentity } from './identity';

/** NIP-44 v2 encrypt `plaintext` to `peerPubkeyHex` under `identity`. */
export function nip44Encrypt(
  identity: NostrIdentity,
  peerPubkeyHex: string,
  plaintext: string,
): string {
  return nip44v2Encrypt(plaintext, getConversationKey(identity.privateKey, peerPubkeyHex));
}

/** NIP-44 v2 decrypt `ciphertext` from `peerPubkeyHex` under `identity`. */
export function nip44Decrypt(
  identity: NostrIdentity,
  peerPubkeyHex: string,
  ciphertext: string,
): string {
  return nip44v2Decrypt(ciphertext, getConversationKey(identity.privateKey, peerPubkeyHex));
}

/** Legacy NIP-04 encrypt (kept for older dapps that predate NIP-44). */
export function nip04Encrypt(
  identity: NostrIdentity,
  peerPubkeyHex: string,
  plaintext: string,
): string {
  return nip04v1Encrypt(identity.privateKey, peerPubkeyHex, plaintext);
}

/** Legacy NIP-04 decrypt. */
export function nip04Decrypt(
  identity: NostrIdentity,
  peerPubkeyHex: string,
  ciphertext: string,
): string {
  return nip04v1Decrypt(identity.privateKey, peerPubkeyHex, ciphertext);
}
