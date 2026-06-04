/**
 * Local IndexedDB-backed backup of per-tip private keys.
 *
 * **Why this exists.** The v0.3 two-phase tip-creation flow already
 * persists each tip's encrypted key on the backend BEFORE the sender
 * broadcasts on-chain (see `tip-handler.ts`). That closes the
 * atomicity hole that bit us in the May 2026 dogfooding session.
 * The backend itself is also backed up — daily full + every-6-hours
 * db-only — pulled off-host to `such-backup` via SSH forced command,
 * 30-day retention with SHA256 checksums (see
 * `~/src/such-backup-and-nodes/backup-jobs/smirk-backup.md`).
 *
 * This module is a third layer of defense on top of those: encrypt
 * the raw tip private key (or Grin voucher JSON) with a wallet-
 * derived key, store in `chrome.storage.local` keyed by `tipId`.
 * Useful in scenarios the server-side backups don't cover:
 *   - Backend cooperative but data-corrupted between snapshots
 *     (e.g., a buggy migration writes wrong rows that the daily
 *     restore wouldn't notice for ~24h)
 *   - User offline / backend unreachable when they need to recover
 *   - Cross-device migration (export the seed → re-import → these
 *     entries decrypt against the same BTC-derived key)
 * If both this layer AND the backend are lost, the tip is
 * unrecoverable. That requires losing both wallet + the prod DB
 * + every backup snapshot.
 *
 * **Encryption key.** `sha256(wallet.keys.btc.privateKey)` — same
 * scheme v0.2.4's `storeTipKeyLocally` used (smirk-extension/src/
 * background/social/create.ts). Doesn't require an extra password
 * prompt because the user is already unlocked when tipping.
 *
 * **Storage backend.** `chrome.storage.local` rather than IndexedDB
 * because it's the same backend the extension's keystore already
 * uses, survives browser close, and has a simpler API. Note the
 * 10 MiB total quota — each backup is ~200 bytes, so we'd hit
 * ~50k tips before that matters.
 *
 * **Cleanup.** Successful clawback or claim removes the local
 * backup (`removeTipKeyBackup`). Drafts that the sender cancels
 * are removed in the cancel handler too. Abandoned drafts (popup
 * closed mid-flow) leak — the sweep-from-local-backup recovery
 * surface lists them so the user can clean them up.
 */

import { sha256 } from '@noble/hashes/sha256';
import { encrypt, decrypt, bytesToHex, hexToBytes } from '@smirk/core';

const STORAGE_PREFIX = 'smirk:tip-key-backup:';

/** Asset-tagged record so the recovery flow knows how to interpret
 *  `keyMaterialHex` per chain. */
export interface TipKeyBackup {
  tipId: string;
  asset: 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin';
  /** Address where the funds live (or commitment hex for Grin). */
  tipAddress: string;
  amount: number;
  createdAt: number;
  isPublic: boolean;
  /** Hex-encoded ciphertext of the per-asset key material. For
   *  BTC/LTC: 32-byte secp256k1 private key. For XMR/WOW: 32-byte
   *  Monero spend key. For Grin: JSON-encoded
   *  GrinVoucherEncryptionData (blind + commitment + proof +
   *  n_child + amount + features). */
  keyCiphertextHex: string;
  /**
   * Base64url-encoded URL fragment key used to derive the per-tip
   * share URL (`https://smirk.cash/tip/{id}#{fragment}`). Public tips
   * only. Without this the sender can't reconstruct the share URL
   * after popup close — the fragment isn't persisted server-side by
   * design (it's the secret that decrypts the backend's
   * `encrypted_key` payload, must never leave the client). v0.2.4
   * stored the equivalent in IndexedDB `pendingTips`; v0.3 lost the
   * affordance until 2026-06-04 when the Sent Tips ready-to-share
   * surface needed it. Older backups (pre-2026-06-04) lack this
   * field — those tips can still be clawed back, just no Copy URL.
   */
  urlFragmentEncoded?: string;
}

/** Derive the symmetric encryption key from the wallet's BTC private
 *  key. Stable across sessions for the same wallet — restoring from
 *  seed recovers the same key. */
function deriveStorageKey(btcPrivateKey: Uint8Array): Uint8Array {
  return sha256(btcPrivateKey);
}

/** Store a tip-key backup locally. Idempotent — re-storing the same
 *  tipId overwrites the previous entry. Fails silently to console.warn
 *  rather than throw so a broken local-storage backend doesn't break
 *  the on-chain tip flow. */
export async function storeTipKeyBackup(params: {
  tipId: string;
  asset: TipKeyBackup['asset'];
  tipAddress: string;
  amount: number;
  isPublic: boolean;
  /** Raw per-asset key material — encrypted before storage. */
  keyMaterial: Uint8Array;
  btcPrivateKey: Uint8Array;
  /** For public tips: the URL fragment used to encrypt the backend's
   *  `encrypted_key`. Required to reconstruct the share URL after
   *  popup close. Undefined for directed tips (which use the
   *  recipient's pubkey for encryption — no URL needed). */
  urlFragmentEncoded?: string;
}): Promise<void> {
  try {
    const storageKey = deriveStorageKey(params.btcPrivateKey);
    const ciphertext = encrypt(params.keyMaterial, storageKey);
    const record: TipKeyBackup = {
      tipId: params.tipId,
      asset: params.asset,
      tipAddress: params.tipAddress,
      amount: params.amount,
      createdAt: Date.now(),
      isPublic: params.isPublic,
      keyCiphertextHex: bytesToHex(ciphertext),
      ...(params.urlFragmentEncoded
        ? { urlFragmentEncoded: params.urlFragmentEncoded }
        : {}),
    };
    await chrome.storage.local.set({
      [`${STORAGE_PREFIX}${params.tipId}`]: record,
    });
  } catch (err) {
    console.warn('[tip-key-backup] failed to store local backup:', err);
    // Intentional: don't throw. The backend already has the key
    // (this is a third-layer-of-defense backup). Failing to write
    // locally degrades to "backend-only" which is the v0.3 default.
  }
}

/** Remove a tip-key backup. Called after successful clawback /
 *  claim. */
export async function removeTipKeyBackup(tipId: string): Promise<void> {
  try {
    await chrome.storage.local.remove(`${STORAGE_PREFIX}${tipId}`);
  } catch (err) {
    console.warn('[tip-key-backup] failed to remove:', err);
  }
}

/** List all locally-stored tip backups. Used by the Sent Tips UI
 *  to surface orphan drafts (backend lost the row but we have the
 *  key locally) and to reconcile against backend `getSentSocialTips`. */
export async function listTipKeyBackups(): Promise<TipKeyBackup[]> {
  try {
    const all = await chrome.storage.local.get(null);
    const out: TipKeyBackup[] = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(STORAGE_PREFIX)) continue;
      out.push(v as TipKeyBackup);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    console.warn('[tip-key-backup] failed to list:', err);
    return [];
  }
}

/** Decrypt a stored backup's key material. Throws on bad key (which
 *  means the user is restoring with a different seed, or the local
 *  storage was tampered with — either way the recovery flow should
 *  surface the failure). */
export function decryptTipKeyBackup(
  backup: TipKeyBackup,
  btcPrivateKey: Uint8Array,
): Uint8Array {
  const storageKey = deriveStorageKey(btcPrivateKey);
  return decrypt(hexToBytes(backup.keyCiphertextHex), storageKey);
}

/** Look up a single backup by tipId. Returns `null` if absent —
 *  the on-chain clawback flow uses this to decide whether to fall
 *  back to a "no local backup, can't sweep" error. */
export async function getTipKeyBackup(
  tipId: string,
): Promise<TipKeyBackup | null> {
  try {
    const result = await chrome.storage.local.get(`${STORAGE_PREFIX}${tipId}`);
    const value = result[`${STORAGE_PREFIX}${tipId}`];
    return (value as TipKeyBackup) ?? null;
  } catch (err) {
    console.warn('[tip-key-backup] failed to get:', err);
    return null;
  }
}
