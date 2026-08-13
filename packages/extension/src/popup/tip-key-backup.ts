/**
 * Local `chrome.storage.local` backup of per-tip private keys.
 *
 * **Why this exists.** The v0.3 two-phase tip-creation flow already
 * persists each tip's encrypted key on the backend BEFORE the sender
 * broadcasts on-chain (see `tip-handler.ts`). That closes the
 * atomicity hole that bit us in the May 2026 dogfooding session.
 * The backend itself is also backed up off-host (daily full +
 * every-6-hours db-only, with checksums + retention).
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
 * **Encryption key.** `sha256(wallet.keys.btc.privateKey)`: same
 * scheme v0.2.4's `storeTipKeyLocally` used (smirk-extension/src/
 * background/social/create.ts). Doesn't require an extra password
 * prompt because the user is already unlocked when tipping.
 *
 * **Everything secret is encrypted, including the URL fragment.**
 * Until 2026-08 the public-tip URL fragment sat NEXT TO the
 * ciphertext in cleartext. That fragment decrypts the copy of the
 * key the backend serves UNAUTHENTICATED to anyone holding the tip
 * UUID, so a reader of the Chrome profile (stolen laptop,
 * unencrypted backup, forensic image) could sweep every unclaimed
 * public tip WITHOUT the wallet password: exactly the at-rest attack
 * this module exists to blunt. It is now sealed under the same
 * wallet-derived key. Records written before that still decrypt
 * (the plaintext form is read as-is) and are re-written encrypted
 * the next time they are read.
 *
 * **Storage backend.** `chrome.storage.local` rather than IndexedDB
 * because it's the same backend the extension's keystore already
 * uses, survives browser close, and has a simpler API. Note the
 * 10 MiB total quota: each backup is ~200 bytes, so we'd hit
 * ~50k tips before that matters.
 *
 * **Cleanup.** Successful clawback or claim removes the local
 * backup (`removeTipKeyBackup`). Drafts that the sender cancels
 * are removed in the cancel handler too. Abandoned drafts (popup
 * closed mid-flow) leak; the sweep-from-local-backup recovery
 * surface lists them so the user can clean them up.
 */

import { sha256 } from '@noble/hashes/sha256';
import { encrypt, decrypt, bytesToHex, hexToBytes } from '@smirk/core';

import { walletKeystore } from './singletons';

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
   * Hex-encoded ciphertext (same wallet-derived key as
   * `keyCiphertextHex`) of the base64url URL fragment key used to
   * derive the per-tip share URL
   * (`https://smirk.cash/tip/{id}#{fragment}`). Public tips only.
   * Without it the sender can't reconstruct the share URL after
   * popup close: the fragment isn't persisted server-side by design
   * (it's the secret that decrypts the backend's `encrypted_key`
   * payload, must never leave the client). v0.2.4 stored the
   * equivalent in IndexedDB `pendingTips`; v0.3 lost the affordance
   * until 2026-06-04 when the Sent Tips ready-to-share surface
   * needed it. Older backups (pre-2026-06-04) have no fragment at
   * all; those tips can still be clawed back, just no Copy URL.
   */
  urlFragmentCiphertextHex?: string;
  /**
   * The PLAINTEXT fragment. Two meanings, both handled by the read
   * helpers below:
   *   - on a record straight out of storage: a pre-2026-08 backup,
   *     written before the fragment was encrypted at rest (see the
   *     file header). Still readable, and re-written in the
   *     encrypted form on the next read.
   *   - on a record RETURNED by `listTipKeyBackups` /
   *     `getTipKeyBackup`: the decrypted fragment, hydrated in
   *     memory for an unlocked wallet so share-URL call sites keep
   *     reading one field.
   * Never written in this form.
   */
  urlFragmentEncoded?: string;
}

/** Derive the symmetric encryption key from the wallet's BTC private
 *  key. Stable across sessions for the same wallet: restoring from
 *  seed recovers the same key. */
function deriveStorageKey(btcPrivateKey: Uint8Array): Uint8Array {
  return sha256(btcPrivateKey);
}

/** The fragment is base64url text; seal it under the same key as the
 *  key material. */
function encryptFragment(fragment: string, storageKey: Uint8Array): string {
  return bytesToHex(encrypt(new TextEncoder().encode(fragment), storageKey));
}

function decryptFragment(ciphertextHex: string, storageKey: Uint8Array): string {
  return new TextDecoder().decode(decrypt(hexToBytes(ciphertextHex), storageKey));
}

/** Storage key of the wallet unlocked RIGHT NOW, or null when locked.
 *  Every read site already runs behind an unlocked wallet, so resolving
 *  the key here keeps their call signatures unchanged; a locked wallet
 *  legitimately gets no fragment back. */
async function activeStorageKey(): Promise<Uint8Array | null> {
  try {
    const state = await walletKeystore.getState();
    if (state.kind !== 'unlocked') return null;
    const btcPrivateKey = state.wallet.keys?.btc?.privateKey;
    return btcPrivateKey ? deriveStorageKey(btcPrivateKey) : null;
  } catch (err) {
    console.warn('[tip-key-backup] failed to read wallet state:', err);
    return null;
  }
}

/** Upgrade a pre-2026-08 record whose fragment sat next to the
 *  ciphertext in cleartext. Best effort: on failure the legacy record
 *  stays as it is and the next read tries again. */
async function rewriteLegacyFragment(
  record: TipKeyBackup,
  storageKey: Uint8Array,
): Promise<void> {
  if (!record.urlFragmentEncoded) return;
  // Only the OWNING wallet may re-key a record. Backups are keyed by
  // tipId, not by wallet, so a re-imported DIFFERENT seed lists the
  // previous wallet's rows too, and re-encrypting one under the wrong
  // key would lose that share URL for good. The key ciphertext is
  // authenticated, so a clean decrypt is the proof.
  try {
    decrypt(hexToBytes(record.keyCiphertextHex), storageKey);
  } catch {
    return;
  }
  try {
    const upgraded: TipKeyBackup = { ...record };
    delete upgraded.urlFragmentEncoded;
    upgraded.urlFragmentCiphertextHex = encryptFragment(
      record.urlFragmentEncoded,
      storageKey,
    );
    await chrome.storage.local.set({
      [`${STORAGE_PREFIX}${record.tipId}`]: upgraded,
    });
  } catch (err) {
    console.warn('[tip-key-backup] failed to re-encrypt a legacy fragment:', err);
  }
}

/** In-memory view of a stored record with `urlFragmentEncoded` filled
 *  in, migrating the legacy plaintext form on the way past. */
async function hydrateFragment(
  record: TipKeyBackup,
  storageKey: Uint8Array | null,
): Promise<TipKeyBackup> {
  if (record.urlFragmentEncoded) {
    // Legacy record: readable as-is, and this read is the "next touch"
    // that upgrades it.
    if (storageKey) await rewriteLegacyFragment(record, storageKey);
    return record;
  }
  if (!record.urlFragmentCiphertextHex || !storageKey) return record;
  try {
    return {
      ...record,
      urlFragmentEncoded: decryptFragment(record.urlFragmentCiphertextHex, storageKey),
    };
  } catch (err) {
    // Wrong seed or tampered storage. The tip is still clawback-able
    // via keyCiphertextHex; only the share URL is unavailable.
    console.warn('[tip-key-backup] failed to decrypt url fragment:', err);
    return record;
  }
}

/** Store a tip-key backup locally. Idempotent: re-storing the same
 *  tipId overwrites the previous entry. Fails silently to console.warn
 *  rather than throw so a broken local-storage backend doesn't break
 *  the on-chain tip flow. */
export async function storeTipKeyBackup(params: {
  tipId: string;
  asset: TipKeyBackup['asset'];
  tipAddress: string;
  amount: number;
  isPublic: boolean;
  /** Raw per-asset key material, encrypted before storage. */
  keyMaterial: Uint8Array;
  btcPrivateKey: Uint8Array;
  /** For public tips: the URL fragment used to encrypt the backend's
   *  `encrypted_key`. Required to reconstruct the share URL after
   *  popup close. Undefined for directed tips (which use the
   *  recipient's pubkey for encryption: no URL needed). */
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
      // Encrypted, never cleartext: this fragment opens the copy of the
      // key the backend hands out unauthenticated (see the file header).
      ...(params.urlFragmentEncoded
        ? {
            urlFragmentCiphertextHex: encryptFragment(
              params.urlFragmentEncoded,
              storageKey,
            ),
          }
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
 *  key locally) and to reconcile against backend `getSentSocialTips`.
 *  Returned records carry the DECRYPTED `urlFragmentEncoded` when the
 *  wallet is unlocked; pass `btcPrivateKey` to be explicit about which
 *  wallet, otherwise the currently-unlocked one is used. */
export async function listTipKeyBackups(
  btcPrivateKey?: Uint8Array,
): Promise<TipKeyBackup[]> {
  try {
    const all = await chrome.storage.local.get(null);
    const storageKey = btcPrivateKey
      ? deriveStorageKey(btcPrivateKey)
      : await activeStorageKey();
    const out: TipKeyBackup[] = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(STORAGE_PREFIX)) continue;
      out.push(await hydrateFragment(v as TipKeyBackup, storageKey));
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    console.warn('[tip-key-backup] failed to list:', err);
    return [];
  }
}

/** Decrypt a stored backup's key material. Throws on bad key (which
 *  means the user is restoring with a different seed, or the local
 *  storage was tampered with; either way the recovery flow should
 *  surface the failure). */
export function decryptTipKeyBackup(
  backup: TipKeyBackup,
  btcPrivateKey: Uint8Array,
): Uint8Array {
  const storageKey = deriveStorageKey(btcPrivateKey);
  return decrypt(hexToBytes(backup.keyCiphertextHex), storageKey);
}

/** Decrypt a stored backup's share-URL fragment (public tips only).
 *  Returns null when the record has no fragment or it can't be read
 *  with this wallet's key. Call sites holding the unlocked wallet can
 *  use this instead of relying on the hydrated field. */
export function decryptTipKeyBackupFragment(
  backup: TipKeyBackup,
  btcPrivateKey: Uint8Array,
): string | null {
  // Pre-2026-08 record: the fragment is already in the clear.
  if (backup.urlFragmentEncoded) return backup.urlFragmentEncoded;
  if (!backup.urlFragmentCiphertextHex) return null;
  try {
    return decryptFragment(
      backup.urlFragmentCiphertextHex,
      deriveStorageKey(btcPrivateKey),
    );
  } catch (err) {
    console.warn('[tip-key-backup] failed to decrypt url fragment:', err);
    return null;
  }
}

/** Look up a single backup by tipId. Returns `null` if absent;
 *  the on-chain clawback flow uses this to decide whether to fall
 *  back to a "no local backup, can't sweep" error. */
export async function getTipKeyBackup(
  tipId: string,
  btcPrivateKey?: Uint8Array,
): Promise<TipKeyBackup | null> {
  try {
    const result = await chrome.storage.local.get(`${STORAGE_PREFIX}${tipId}`);
    const value = result[`${STORAGE_PREFIX}${tipId}`] as TipKeyBackup | undefined;
    if (!value) return null;
    const storageKey = btcPrivateKey
      ? deriveStorageKey(btcPrivateKey)
      : await activeStorageKey();
    return hydrateFragment(value, storageKey);
  } catch (err) {
    console.warn('[tip-key-backup] failed to get:', err);
    return null;
  }
}
