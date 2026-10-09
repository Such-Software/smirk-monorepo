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
 *
 * It also needs a server that advertises `features.legacy_merge_v2`
 * ({@link legacyMergeAllowed}). An older server merges any unanchored row whose
 * BTC key row matches the old key, and any session holder can write that row
 * with `POST /keys`; it also accepts a v0.3 row as "legacy". Sending the proof
 * there would let a planted row fold into the user's account on their next
 * unlock. Without the flag the wallet signs in exactly as v0.3.0 did.
 */

import { sha256 } from '@noble/hashes/sha256';

import { capHasLegacyMergeV2, loadCapabilities, type BackendCapabilities } from './api';
import { bytesToHex, signBitcoinMessage } from './crypto';
import { deriveLegacyBtcLtcKey } from './hd';

/**
 * True when this server may be sent a rotation proof or a merge request: it
 * advertises the hardened merge. Closed on an older, unreachable or silent
 * server. Read through the session capabilities cache.
 */
export async function legacyMergeAllowed(
  api: { getBaseUrl(): string; getCapabilities(): Promise<{ data?: BackendCapabilities | null }> },
): Promise<boolean> {
  return capHasLegacyMergeV2(await loadCapabilities(api).catch(() => null));
}

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

/**
 * After an npub sign-in, merge a pre-v0.3 identity into the signed-in one.
 *
 * A wallet imported by v0.3.0 could not prove its legacy key, so it may hold a
 * second identity while its handle, tips and premium sit on the legacy row. The
 * BTC sign-in path carries the proof itself; the npub path never reaches it, so
 * it asks here. Needs the seed (fresh unlock or import), a session, and a server
 * that advertises the hardened merge ({@link legacyMergeAllowed}). Never throws:
 * a skipped, failed or refused merge leaves both identities as they were.
 */
export async function mergeLegacyIdentityAfterSignIn(
  api: {
    getBaseUrl(): string;
    getCapabilities(): Promise<{ data?: BackendCapabilities | null }>;
    legacyMerge(params: {
      btcPublicKey: string;
      previousPublicKey: string;
      signedTimestamp: number;
      rotationSignature: string;
    }): Promise<{ data?: { outcome: string; conflict?: string }; error?: string }>;
  },
  wallet: { seed?: Uint8Array; keys: { btc: { publicKey: Uint8Array } } },
): Promise<'merged' | 'nothing_to_merge' | 'conflict' | 'skipped' | 'failed'> {
  if (!wallet.seed) return 'skipped';
  if (!(await legacyMergeAllowed(api))) return 'skipped';
  const btcPublicKey = bytesToHex(wallet.keys.btc.publicKey);
  const signedTimestamp = Math.floor(Date.now() / 1000);
  const proof = legacyBtcRotationProof(wallet.seed, btcPublicKey, signedTimestamp, api.getBaseUrl());
  if (!proof) return 'skipped';
  try {
    const res = await api.legacyMerge({
      btcPublicKey,
      previousPublicKey: proof.rotationPublicKey,
      signedTimestamp,
      rotationSignature: proof.rotationSignature,
    });
    const outcome = res.data?.outcome;
    if (outcome === 'conflict') {
      console.warn(`[legacy-merge] refused: both identities hold a different ${res.data?.conflict}`);
    }
    return outcome === 'merged' || outcome === 'nothing_to_merge' || outcome === 'conflict'
      ? outcome
      : 'failed';
  } catch (e) {
    console.warn('[legacy-merge] request failed:', e);
    return 'failed';
  }
}
