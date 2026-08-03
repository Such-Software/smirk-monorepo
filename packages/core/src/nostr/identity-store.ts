/**
 * Multi-identity vault: "one wallet, many Nostr identities" (P2, the Goblin
 * interop plan). Holds a set of identities the user switches between:
 *   - `derived`:   seed-derived NIP-06 hardened accounts (recoverable from the
 *                  mnemonic; no secret stored here);
 *   - `burner`:    fresh RANDOM keys, deliberately seed-independent (a leaked seed
 *                  can't derive them: Goblin's compartmentalization);
 *   - `imported`:  an `nsec` carried in from another wallet (e.g. Goblin).
 *
 * Burner/imported SECRETS never live in this vault in the clear: the host
 * (wallet) injects an `encrypt`/`decrypt` bound to the unlocked keystore, and only
 * the ciphertext is persisted. Derived identities store no secret (re-derived on
 * demand). A `label` is a PRIVATE local tag: never published to any relay.
 *
 * This module is pure over the vault object; persistence + secret crypto are the
 * host's concern. `resolvePostingIdentity()` (notes.ts) is the seam that reads the
 * active identity, so call sites don't change as identities multiply.
 */

import { utf8ToBytes } from '@noble/hashes/utils';

import {
  deriveNostrIdentity,
  generateBurnerIdentity,
  importNostrIdentity,
  nostrIdentityFromPrivkey,
  type NostrIdentity,
} from './identity';

export type IdentitySource = 'derived' | 'burner' | 'imported';

/** A stored identity descriptor. No secret material: see the module header. */
export interface StoredIdentity {
  /** x-only pubkey hex: the stable id + what's shown before unlock. */
  pubkeyHex: string;
  npub: string;
  source: IdentitySource;
  /** For `derived`: the hardened NIP-06 account index. Absent otherwise. */
  account?: number;
  /** PRIVATE local label: NEVER published (kind-0 or otherwise). */
  label?: string;
}

/** The persisted vault. `secrets` holds host-encrypted keys for burner/imported
 *  identities only (keyed by pubkey hex); derived identities have no entry. */
export interface IdentityVault {
  version: 1;
  /** pubkey hex of the active identity. */
  active: string;
  /** Display order = array order. */
  identities: StoredIdentity[];
  secrets: Record<string, string>;
}

/** Encrypt a 32-byte secret → opaque ciphertext string (host: keystore-bound). */
export type EncryptSecret = (secret: Uint8Array) => string;
/** Inverse of {@link EncryptSecret}. */
export type DecryptSecret = (ciphertext: string) => Uint8Array;

function toStored(id: NostrIdentity, source: IdentitySource, label?: string): StoredIdentity {
  return {
    pubkeyHex: id.pubkeyHex,
    npub: id.npub,
    source,
    ...(source === 'derived' ? { account: id.account } : {}),
    ...(label ? { label } : {}),
  };
}

/** The lowest hardened account not already used by a `derived` identity. */
function nextFreeAccount(vault: IdentityVault): number {
  const used = new Set(
    vault.identities.filter((i) => i.source === 'derived').map((i) => i.account ?? -1),
  );
  let n = 0;
  while (used.has(n)) n += 1;
  return n;
}

/** A fresh vault seeded with the wallet's default (account-0) derived identity,
 *  set active. Idempotent entry point for a wallet that has none yet. */
export function initIdentityVault(mnemonic: string): IdentityVault {
  const main = deriveNostrIdentity(mnemonic, 0);
  return {
    version: 1,
    active: main.pubkeyHex,
    identities: [toStored(main, 'derived')],
    secrets: {},
  };
}

export function listIdentities(vault: IdentityVault): StoredIdentity[] {
  return vault.identities;
}

export function activeStored(vault: IdentityVault): StoredIdentity | undefined {
  return vault.identities.find((i) => i.pubkeyHex === vault.active);
}

/**
 * Resolve a stored identity to a usable {@link NostrIdentity} (with the private
 * key). Derived → re-derive from the mnemonic; burner/imported → decrypt the
 * stored secret via the host `decrypt`.
 */
export function resolveIdentity(
  vault: IdentityVault,
  pubkeyHex: string,
  mnemonic: string,
  decrypt: DecryptSecret,
): NostrIdentity {
  const stored = vault.identities.find((i) => i.pubkeyHex === pubkeyHex);
  if (!stored) throw new Error(`unknown identity: ${pubkeyHex}`);
  if (stored.source === 'derived') {
    return deriveNostrIdentity(mnemonic, stored.account ?? 0);
  }
  const ct = vault.secrets[pubkeyHex];
  if (!ct) throw new Error(`no stored secret for identity ${pubkeyHex}`);
  return nostrIdentityFromPrivkey(decrypt(ct));
}

/** Resolve the ACTIVE identity: the one posting/DM/login should use. */
export function resolveActiveIdentity(
  vault: IdentityVault,
  mnemonic: string,
  decrypt: DecryptSecret,
): NostrIdentity {
  return resolveIdentity(vault, vault.active, mnemonic, decrypt);
}

/** Add the next seed-derived identity (recoverable from the mnemonic). */
export function addDerivedIdentity(
  vault: IdentityVault,
  mnemonic: string,
  label?: string,
): { vault: IdentityVault; identity: StoredIdentity } {
  const id = deriveNostrIdentity(mnemonic, nextFreeAccount(vault));
  const stored = toStored(id, 'derived', label);
  return {
    vault: { ...vault, identities: [...vault.identities, stored] },
    identity: stored,
  };
}

function addWithSecret(
  vault: IdentityVault,
  id: NostrIdentity,
  source: 'burner' | 'imported',
  encrypt: EncryptSecret,
  label?: string,
): { vault: IdentityVault; identity: StoredIdentity } {
  if (vault.identities.some((i) => i.pubkeyHex === id.pubkeyHex)) {
    throw new Error('identity already exists');
  }
  const stored = toStored(id, source, label);
  return {
    vault: {
      ...vault,
      identities: [...vault.identities, stored],
      secrets: { ...vault.secrets, [id.pubkeyHex]: encrypt(id.privateKey) },
    },
    identity: stored,
  };
}

/** Generate + add a fresh random burner identity (secret encrypted by the host). */
export function addBurnerIdentity(
  vault: IdentityVault,
  encrypt: EncryptSecret,
  label?: string,
): { vault: IdentityVault; identity: StoredIdentity } {
  return addWithSecret(vault, generateBurnerIdentity(), 'burner', encrypt, label);
}

/** Import an identity from an `nsec` (secret encrypted by the host). */
export function importIdentity(
  vault: IdentityVault,
  nsec: string,
  encrypt: EncryptSecret,
  label?: string,
): { vault: IdentityVault; identity: StoredIdentity } {
  return addWithSecret(vault, importNostrIdentity(nsec), 'imported', encrypt, label);
}

/** Set the active identity (must already be in the vault). */
export function setActiveIdentity(vault: IdentityVault, pubkeyHex: string): IdentityVault {
  if (!vault.identities.some((i) => i.pubkeyHex === pubkeyHex)) {
    throw new Error(`cannot activate unknown identity: ${pubkeyHex}`);
  }
  return { ...vault, active: pubkeyHex };
}

/** Rename an identity's PRIVATE local label (empty clears it). */
export function renameIdentity(
  vault: IdentityVault,
  pubkeyHex: string,
  label: string,
): IdentityVault {
  return {
    ...vault,
    identities: vault.identities.map((i) => {
      if (i.pubkeyHex !== pubkeyHex) return i;
      const { label: _drop, ...rest } = i;
      return label ? { ...rest, label } : rest;
    }),
  };
}

/**
 * Remove an identity. Refuses to remove the last one. If it was active, activates
 * a survivor. Drops any stored secret. NOTE: a burner/imported key removed here is
 * gone unless separately backed up (nsec): the caller must confirm.
 */
export function removeIdentity(vault: IdentityVault, pubkeyHex: string): IdentityVault {
  if (vault.identities.length <= 1) throw new Error('cannot remove the last identity');
  const identities = vault.identities.filter((i) => i.pubkeyHex !== pubkeyHex);
  if (identities.length === vault.identities.length) return vault; // not present
  const secrets = { ...vault.secrets };
  delete secrets[pubkeyHex];
  const active = vault.active === pubkeyHex ? identities[0]!.pubkeyHex : vault.active;
  return { ...vault, active, identities, secrets };
}

// ── Encrypted vault backup / restore ────────────────────────────────────────
// Burner + imported keys are NOT seed-derived, so they vanish on reinstall unless
// backed up. These build a single portable, encrypted blob of the WHOLE vault so a
// user can carry every identity (roster + labels + burner/imported secrets) across
// devices. The whole JSON is sealed under the host's mnemonic-derived key (same
// trust boundary as the seed), so the file never leaks the PRIVATE labels/roster in
// the clear, and a wrong-seed restore fails cleanly on the Poly1305 tag.

const BACKUP_KIND = 'smirk-nostr-vault-backup';

/** Versioned envelope for an encrypted vault backup. `ct` is the sealed JSON of the
 *  whole {@link IdentityVault}. `fp` is the PUBLIC seed fingerprint (cleartext) so a
 *  restore can warn about a wrong-wallet file before attempting to decrypt. */
export interface VaultBackupEnvelope {
  kind: typeof BACKUP_KIND;
  v: 1;
  fp: string;
  alg: 'xchacha20poly1305';
  ct: string;
}

/** Serialize + seal the whole vault. `seal` is the host's mnemonic-derived blob
 *  cipher (`vaultCrypto(mnemonic).encrypt`). Returns a pretty JSON envelope string. */
export function buildVaultBackup(
  vault: IdentityVault,
  fingerprint: string,
  seal: EncryptSecret,
): string {
  const ct = seal(utf8ToBytes(JSON.stringify(vault)));
  const env: VaultBackupEnvelope = {
    kind: BACKUP_KIND,
    v: 1,
    fp: fingerprint,
    alg: 'xchacha20poly1305',
    ct,
  };
  return JSON.stringify(env, null, 2);
}

/** Read the fingerprint stamped on a backup WITHOUT decrypting: lets a caller warn
 *  "this backup is from a different wallet" before prompting for anything. Returns
 *  null if the text isn't a recognizable backup envelope. */
export function peekVaultBackupFingerprint(text: string): string | null {
  try {
    const env = JSON.parse(text) as VaultBackupEnvelope;
    return env?.kind === BACKUP_KIND && typeof env.fp === 'string' ? env.fp : null;
  } catch {
    return null;
  }
}

/** Parse + open a backup. Throws on a bad envelope, tamper, or wrong seed (the
 *  `open` cipher surfaces the Poly1305 failure). Returns the exact vault backed up. */
export function parseVaultBackup(text: string, open: DecryptSecret): IdentityVault {
  let env: VaultBackupEnvelope;
  try {
    env = JSON.parse(text) as VaultBackupEnvelope;
  } catch {
    throw new Error('Not a valid backup file');
  }
  if (env?.kind !== BACKUP_KIND || env.v !== 1 || typeof env.ct !== 'string') {
    throw new Error('Not a Smirk identities backup');
  }
  const json = new TextDecoder().decode(open(env.ct)); // wrong seed → throws here
  const vault = JSON.parse(json) as IdentityVault;
  if (vault?.version !== 1 || !Array.isArray(vault.identities) || typeof vault.active !== 'string') {
    throw new Error('Backup is corrupt');
  }
  return vault;
}

/** Merge an imported vault INTO a base (the reinstalled wallet's seeded vault).
 *  Dedupe by pubkeyHex (base wins on conflict: keeps the live secret + label),
 *  append the incoming's new identities + their (already-sealed) secrets, and adopt
 *  the incoming `active` only if it survives the merge. Pure. */
export function mergeVault(base: IdentityVault, incoming: IdentityVault): IdentityVault {
  const have = new Set(base.identities.map((i) => i.pubkeyHex));
  const added = incoming.identities.filter((i) => !have.has(i.pubkeyHex));
  const identities = [...base.identities, ...added];
  const secrets = { ...base.secrets };
  for (const id of added) {
    const ct = incoming.secrets[id.pubkeyHex];
    if (ct) secrets[id.pubkeyHex] = ct; // already ciphertext under the SAME key
  }
  const active = identities.some((i) => i.pubkeyHex === incoming.active)
    ? incoming.active
    : base.active;
  return { version: 1, active, identities, secrets };
}
