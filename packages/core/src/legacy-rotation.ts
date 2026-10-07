/**
 * Carry a pre-v0.3 identity over to the v0.3 BTC key.
 *
 * Wallets created before v0.3 were registered under the BTC key at
 * `m/44'/0'/0'/0/0`, and the backend's `migrate-legacy` import kept only
 * `pubkey_hash = hex(SHA256(that key's hex))`, with no key rows. v0.3 derives
 * BTC at `m/84'`, so the first v0.3 registration presents a key the backend has
 * never seen. Without proof that the same seed controls the old key, the backend
 * must treat it as a new identity and the old handle, tips and premium stay on
 * the old row.
 *
 * The proof is the backend's derivation-rotation proof (`smirk-rotate-v1`),
 * signed with the OLD key and presented with that key. The backend accepts the
 * key only when its hash is exactly the row's on-file `pubkey_hash`, and only for
 * the row located by this wallet's seed fingerprint.
 *
 * It needs the seed, which exists only after a fresh password unlock (import
 * included). A grace-session unlock has no seed and simply sends no proof: a
 * migrated wallet is carried over on the import, and later unlocks are ordinary
 * returning logins.
 */

import { sha256 } from '@noble/hashes/sha256';

import { bytesToHex, signBitcoinMessage } from './crypto';
import { deriveLegacyBtcLtcKey } from './hd';

/** BIP44 coin type for Bitcoin. */
const BTC_COIN_TYPE = 0;

/**
 * The message a rotation proof signs. Must match the backend's
 * `rotation_message`: the instance's canonical API base without a trailing `/`,
 * then `hex(SHA256(new BTC public key hex))`, then the signed timestamp.
 */
export function rotationMessage(
  apiBase: string,
  newBtcPublicKeyHex: string,
  signedTimestamp: number,
): string {
  const pubkeyHash = bytesToHex(sha256(new TextEncoder().encode(newBtcPublicKeyHex)));
  return `smirk-rotate-v1|${apiBase.replace(/\/+$/, '')}|${pubkeyHash}|${signedTimestamp}`;
}

/**
 * The pre-v0.3 BTC key's rotation proof for this seed, or `null` when the old
 * and new keys coincide (nothing to rotate).
 */
export function legacyBtcRotationProof(
  seed: Uint8Array,
  newBtcPublicKeyHex: string,
  signedTimestamp: number,
  apiBase: string,
): { rotationPublicKey: string; rotationSignature: string } | null {
  const legacy = deriveLegacyBtcLtcKey(seed, BTC_COIN_TYPE);
  try {
    const rotationPublicKey = bytesToHex(legacy.publicKey);
    if (rotationPublicKey === newBtcPublicKeyHex) return null;
    return {
      rotationPublicKey,
      rotationSignature: signBitcoinMessage(
        rotationMessage(apiBase, newBtcPublicKeyHex, signedTimestamp),
        legacy.privateKey,
      ),
    };
  } finally {
    legacy.privateKey.fill(0);
  }
}
