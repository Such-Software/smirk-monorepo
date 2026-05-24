/**
 * Local IndexedDB-backed backup of per-tip private keys.
 *
 * **Why this exists.** The v0.3 two-phase tip-creation flow already
 * persists each tip's encrypted key on the backend BEFORE the sender
 * broadcasts on-chain (see `tip-handler.ts`). That closes the
 * atomicity hole that bit us in the May 2026 dogfooding session.
 * But it leaves one residual risk: backend DR loss. The smirk-backend
 * postgres instance currently has *no* automated backups (see
 * `ops/backup-postgres.sh` proposal). If the DB is lost, every
 * pending tip becomes unrecoverable — the funds sit at the tip
 * address forever and nobody has the key.
 *
 * This module is a third layer of defense: encrypt the raw tip
 * private key (or Grin voucher JSON) with a wallet-derived key, store
 * in `chrome.storage.local` keyed by `tipId`. If the backend is lost
 * the user can extract the key locally, derive the tip address, and
 * sweep the funds back via any standalone wallet for that asset.
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
