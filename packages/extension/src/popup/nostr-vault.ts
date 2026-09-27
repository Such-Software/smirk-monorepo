/**
 * Host-side Nostr identity vault (P2 switcher). Persists the multi-identity vault
 * (@smirk/core identity-store) in chrome.storage.local, scoped to the wallet's seed
 * fingerprint so re-importing a different wallet gets its own set. Binds the vault's
 * injected secret crypto to a key DERIVED FROM THE MNEMONIC, so burner/imported
 * private keys are encrypted at rest and only decryptable while unlocked.
 *
 * `getActiveNostrIdentity(keySource)` is the single resolver the rest of the popup
 * calls instead of `deriveNostrIdentity(keySource, 0)`: switch the active identity
 * here and sends/DMs/inbox follow.
 */

import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';

import {
  encrypt as cryptoEncrypt,
  decrypt as cryptoDecrypt,
  computeSeedFingerprint,
  initIdentityVault,
  resolveActiveIdentity,
  activeStored,
  nostrIdentityFromPrivkey,
  deriveNostrIdentity,
  deriveNostrIdentityForOrigin,
  resolveIdentity,
  buildVaultBackup,
  parseVaultBackup,
  peekVaultBackupFingerprint,
  mergeVault,
  shortNpub,
  SESSION_CACHE_KEY,
  type IdentityVault,
  type EncryptSecret,
  type DecryptSecret,
  type NostrIdentity,
  type UnlockedWallet,
  nostrKeySource,
  type NostrKeySource,
} from '@smirk/core';

import { storage, sessionStorage } from './singletons';
import { bytesToHex, hexToBytes } from './format';

const VAULT_PREFIX = 'smirk_nostr_vault_v1_';

function sourceFingerprint(source: NostrKeySource): string {
  return typeof source === 'string' ? computeSeedFingerprint(source) : source.fingerprint;
}

function vaultStorageKey(keySource: NostrKeySource): string {
  return VAULT_PREFIX + sourceFingerprint(keySource);
}

/** 32-byte vault-encryption key, domain-separated from the mnemonic. Anyone with
 *  the mnemonic can derive it: same trust boundary as the seed itself.
 *
 *  The `\x00` between the tag and the mnemonic is a load-bearing domain separator
 *  baked into the derived key since v0.3.0. DO NOT change or remove it (or the tag):
 *  doing so re-keys the vault and orphans every already-encrypted burner/imported
 *  secret and every exported backup. It is written as the explicit `\x00` escape
 *  (not a raw NUL byte) so this file stays text-diffable and greppable. */
function vaultKey(keySource: NostrKeySource): Uint8Array {
  if (typeof keySource !== 'string') return keySource.vaultKey.slice();
  return sha256(utf8ToBytes(`smirk-nostr-vault-v1\x00${keySource}`));
}

/** Secret crypto bound to this wallet: ciphertext is hex(XChaCha20-Poly1305). */
export function vaultCrypto(keySource: NostrKeySource): { encrypt: EncryptSecret; decrypt: DecryptSecret } {
  const key = vaultKey(keySource);
  return {
    encrypt: (secret: Uint8Array) => bytesToHex(cryptoEncrypt(secret, key)),
    decrypt: (ciphertext: string) => cryptoDecrypt(hexToBytes(ciphertext), key),
  };
}

function looksLikeVault(v: unknown): v is IdentityVault {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as IdentityVault).version === 1 &&
    Array.isArray((v as IdentityVault).identities) &&
    typeof (v as IdentityVault).active === 'string'
  );
}

/** Load this wallet's vault, seeding a fresh account-0 one on first use. */
export async function loadVault(keySource: NostrKeySource): Promise<IdentityVault> {
  const raw = await storage.get(vaultStorageKey(keySource));
  if (looksLikeVault(raw)) return raw;
  const seeded = initIdentityVault(keySource);
  await storage.set(vaultStorageKey(keySource), seeded);
  return seeded;
}

export async function saveVault(keySource: NostrKeySource, vault: IdentityVault): Promise<void> {
  await storage.set(vaultStorageKey(keySource), vault);
}

/** Read identity labels and the active pointer by wallet fingerprint. Private
 * keys remain encrypted, so this metadata read also works while locked. */
export async function loadVaultByFingerprint(fingerprint: string): Promise<IdentityVault | null> {
  const raw = await storage.get(VAULT_PREFIX + fingerprint);
  return looksLikeVault(raw) ? raw : null;
}

/** Build a portable, encrypted backup of the whole identity vault (roster + labels
 *  + burner/imported secrets), sealed under the mnemonic-derived key. The user
 *  copies or saves this to survive a reinstall. Requires unlocked session keys. */
export async function exportVaultBackup(keySource: NostrKeySource): Promise<string> {
  const vault = await loadVault(keySource);
  return buildVaultBackup(vault, sourceFingerprint(keySource), vaultCrypto(keySource).encrypt);
}

/** Restore a backup into this wallet's vault. Decrypts under the mnemonic (throws
 *  on a wrong-seed file), merges (base wins on conflicts, appends new identities +
 *  secrets), persists, and returns the merged vault. */
export async function restoreVaultBackup(keySource: NostrKeySource, text: string): Promise<IdentityVault> {
  const incoming = parseVaultBackup(text, vaultCrypto(keySource).decrypt);
  const merged = mergeVault(await loadVault(keySource), incoming);
  await saveVault(keySource, merged);
  return merged;
}

/** True when `text` is a backup made under a DIFFERENT seed than `mnemonic`, used
 *  to warn before a doomed decrypt. Null-safe: returns false for non-backups. */
export function isForeignVaultBackup(keySource: NostrKeySource, text: string): boolean {
  const fp = peekVaultBackupFingerprint(text);
  return fp != null && fp !== sourceFingerprint(keySource);
}

/**
 * Resolve the ACTIVE identity for signing/posting/delivery. Falls back to the
 * account-0 derived identity ONLY when account-0 is what is active (no vault
 * yet, or the default is selected): the wallet must always have a usable default
 * identity. For any OTHER active identity an unresolvable secret THROWS, because
 * silently answering with account-0 would post/DM as the user's MAIN identity
 * while they believe they are on a burner. {@link getActiveNostrIdentityFromWallet}
 * turns that into its documented `identity: null, needsUnlock: true`.
 */
export async function getActiveNostrIdentity(keySource: NostrKeySource): Promise<NostrIdentity> {
  // A vault we cannot even READ says nothing about which identity is active, so
  // it cannot be shown to be account-0 either: let that propagate too.
  const vault = await loadVault(keySource);
  const active = activeStored(vault);
  if (!active) throw new Error('The selected Nostr identity is missing from this wallet.');
  // Same rule the wrapper below applies: no entry for the active pointer, or an
  // entry that IS derived account 0.
  const activeIsAccount0 =
    active.source === 'derived' && (active.account ?? 0) === 0;
  try {
    return resolveActiveIdentity(vault, keySource, vaultCrypto(keySource).decrypt);
  } catch (err) {
    if (!activeIsAccount0) throw err;
    return deriveNostrIdentity(keySource, 0);
  }
}

// Legacy active-key cache reader. Complete v3 sessions resolve every identity
// from scoped roots and the encrypted vault; new writes only remove old entries.
// The compatibility reader still checks wallet, chosen identity, and expiry.
const ACTIVE_KEY_SESSION_KEY = 'smirk_nostr_active_v1';

interface CachedActiveKey {
  fingerprint: string;
  pubkeyHex: string;
  privKeyHex: string;
  expiresAtMs: number;
}

/** Drop any cached active-identity key (called on lock + when not caching). */
export async function clearCachedActiveNostrKey(): Promise<void> {
  await sessionStorage.remove(ACTIVE_KEY_SESSION_KEY);
}

/**
 * Complete scoped sessions resolve identities from the encrypted vault directly.
 * Retire older separate-key entries instead of creating a second secret cache
 * whose asynchronous writes could outlive an explicit lock.
 */
export async function cacheActiveNostrKeyForSession(
  _wallet: UnlockedWallet,
  _expiresAtMs: number,
): Promise<void> {
  await clearCachedActiveNostrKey();
}

/** Read the cached active-identity key if it matches this wallet + the expected
 *  active pubkey and hasn't expired. Returns a usable identity or null. */
export async function readCachedActiveNostrKey(
  fingerprint: string,
  expectedPubkeyHex: string,
): Promise<NostrIdentity | null> {
  const raw = (await sessionStorage.get(ACTIVE_KEY_SESSION_KEY)) as CachedActiveKey | undefined;
  if (!raw || raw.fingerprint !== fingerprint || raw.pubkeyHex !== expectedPubkeyHex) return null;
  if (Date.now() >= raw.expiresAtMs) {
    await clearCachedActiveNostrKey();
    return null;
  }
  try {
    return nostrIdentityFromPrivkey(hexToBytes(raw.privKeyHex));
  } catch {
    return null;
  }
}

/**
 * Resolve the Nostr identity a DAPP (origin) should sign/read as. This is the
 * canonical dapp resolver: it makes the identity switcher actually govern dapps
 * and supports opt-in per-origin compartmentalization.
 *
 * - `chosenPubkeyHex` absent → the user's ACTIVE identity (the portable default).
 * - `chosenPubkeyHex` = account-0 → the cached account-0 key (warm-resume-safe).
 * - A per-origin identity is derived from the scoped session root and origin.
 * - `chosenPubkeyHex` = a vault identity (burner/imported/derived-N) → resolved from
 *   the vault using the scoped roots and vault encryption key.
 *
 * Returns null when the chosen identity cannot be resolved. It never substitutes
 * a different identity when the requested key is unavailable.
 */
export async function resolveNostrIdentityForOrigin(
  wallet: UnlockedWallet,
  origin: string,
  chosenPubkeyHex?: string,
): Promise<NostrIdentity | null> {
  const source = nostrKeySource(wallet);
  // account-0: cached, works on a warm resume.
  const account0 = wallet.keys?.nostr ? nostrIdentityFromPrivkey(wallet.keys.nostr.privateKey) : null;
  // No stored choice (a legacy / pre-picker grant) → the wallet's default account-0
  // identity, matching the dapp public cache's default so the displayed npub and the
  // signing key never diverge. A NEW grant persists an explicit nostrPubkey (the
  // active-at-grant identity or a per-origin one) via the connect-prompt picker.
  if (!chosenPubkeyHex) {
    return account0 ?? (source ? deriveNostrIdentity(source, 0) : null);
  }
  if (account0 && account0.pubkeyHex === chosenPubkeyHex) return account0;
  if (source) {
    // A per-origin compartmentalized identity?
    if (origin) {
      const perOrigin = deriveNostrIdentityForOrigin(source, origin);
      if (perOrigin.pubkeyHex === chosenPubkeyHex) return perOrigin;
    }
    // Otherwise a vault identity (burner / imported / derived-N).
    const vault = await loadVault(source);
    if (vault.identities.some((i) => i.pubkeyHex === chosenPubkeyHex)) {
      return resolveIdentity(vault, chosenPubkeyHex, source, vaultCrypto(source).decrypt);
    }
    return null;
  }
  // Compatibility for callers without scoped roots: require the exact cached key.
  return readCachedActiveNostrKey(wallet.fingerprint, chosenPubkeyHex);
}

/** Retire a legacy active-key entry after a vault change. Scoped session roots
 *  resolve the selected identity without a second private-key cache. */
export async function refreshActiveNostrKeyCache(wallet: UnlockedWallet): Promise<void> {
  const stored = (await sessionStorage.get(SESSION_CACHE_KEY)) as
    | { expiresAtMs?: number }
    | undefined;
  if (stored && typeof stored.expiresAtMs === 'number') {
    await cacheActiveNostrKeyForSession(wallet, stored.expiresAtMs);
  }
}

/** A vault identity projected for the @smirk/ui IdentityPicker. Metadata only (no
 *  secrets): the pubkey/npub/label/source are readable without the mnemonic. */
export interface PickerIdentityLite {
  pubkeyHex: string;
  npub: string;
  label?: string;
  source: 'derived' | 'burner' | 'imported';
}

/** List this wallet's Nostr identities for a picker (works on a warm resume: reads
 *  the unencrypted vault metadata by fingerprint). Falls back to just the default
 *  account-0 identity when no vault exists yet. */
export async function listNostrIdentitiesForPicker(
  wallet: UnlockedWallet,
): Promise<PickerIdentityLite[]> {
  const vault = wallet.fingerprint ? await loadVaultByFingerprint(wallet.fingerprint) : null;
  if (vault?.identities?.length) {
    return vault.identities.map((i) => ({
      pubkeyHex: i.pubkeyHex,
      npub: i.npub,
      ...(i.label ? { label: i.label } : {}),
      source: i.source,
    }));
  }
  const res = await getActiveNostrIdentityFromWallet(wallet);
  return res.identity
    ? [{ pubkeyHex: res.identity.pubkeyHex, npub: res.identity.npub, source: 'derived' }]
    : [];
}

/** Result of resolving the active Nostr identity from a (possibly warm-resumed)
 *  wallet. `identity` is null when it can't be produced; `needsUnlock` distinguishes
 *  "the ACTIVE identity's key isn't available warm, re-unlock to use it" from "no
 *  usable identity at all". */
export interface ActiveNostrResolution {
  identity: NostrIdentity | null;
  needsUnlock: boolean;
  /** Active identity's private label / short npub, for a precise re-unlock message. */
  activeLabel?: string;
}

/**
 * Wallet-aware active-identity resolver: the canonical entry point every Nostr
 * surface (messaging, feed, dapp signing) should use instead of
 * `deriveNostrIdentity(wallet.mnemonic, 0)`.
 *
 * Scoped session roots support every identity during the configured unlock period.
 * If resolution fails, the compatibility cache must match the selected identity.
 * An unavailable burner or imported key never falls back to account 0.
 */
export async function getActiveNostrIdentityFromWallet(
  wallet: UnlockedWallet,
): Promise<ActiveNostrResolution> {
  const source = nostrKeySource(wallet);
  // Both fresh and restored sessions resolve the selected identity from their
  // available key source, including encrypted burner and imported identities.
  if (source) {
    try {
      return { identity: await getActiveNostrIdentity(source), needsUnlock: false };
    } catch {
      // fall through to the cached-key path below
    }
  }
  // Compatibility fallback: account 0 is available directly in wallet.keys.
  const account0 = wallet.keys?.nostr
    ? nostrIdentityFromPrivkey(wallet.keys.nostr.privateKey)
    : null;
  const vault = wallet.fingerprint ? await loadVaultByFingerprint(wallet.fingerprint) : null;
  const active = vault ? activeStored(vault) : undefined;
  if (vault && !active) return { identity: null, needsUnlock: true };
  // No vault yet, or the active identity IS the default account-0 → the cached key
  // is exactly right and warm-resume-safe.
  if (!active || (active.source === 'derived' && (active.account ?? 0) === 0)) {
    return { identity: account0, needsUnlock: account0 === null };
  }
  // Active is a non-default identity (burner / imported / derived-N). Try the
  // session-cached active key first (so it survives a warm resume too); otherwise do
  // NOT fall back to account-0; signal a precise re-unlock.
  const cached = await readCachedActiveNostrKey(wallet.fingerprint, active.pubkeyHex);
  if (cached) return { identity: cached, needsUnlock: false };
  return {
    identity: null,
    needsUnlock: true,
    activeLabel: active.label ?? shortNpub(active.npub),
  };
}
