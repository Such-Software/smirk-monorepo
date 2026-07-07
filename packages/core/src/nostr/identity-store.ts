/**
 * Multi-identity vault — "one wallet, many Nostr identities" (P2, the Goblin
 * interop plan). Holds a set of identities the user switches between:
 *   - `derived`  — seed-derived NIP-06 hardened accounts (recoverable from the
 *                  mnemonic; no secret stored here);
 *   - `burner`   — fresh RANDOM keys, deliberately seed-independent (a leaked seed
 *                  can't derive them — Goblin's compartmentalization);
 *   - `imported` — an `nsec` carried in from another wallet (e.g. Goblin).
 *
 * Burner/imported SECRETS never live in this vault in the clear — the host
 * (wallet) injects an `encrypt`/`decrypt` bound to the unlocked keystore, and only
 * the ciphertext is persisted. Derived identities store no secret (re-derived on
 * demand). A `label` is a PRIVATE local tag — never published to any relay.
 *
 * This module is pure over the vault object; persistence + secret crypto are the
 * host's concern. `resolvePostingIdentity()` (notes.ts) is the seam that reads the
 * active identity, so call sites don't change as identities multiply.
 */

import {
  deriveNostrIdentity,
  generateBurnerIdentity,
  importNostrIdentity,
  nostrIdentityFromPrivkey,
  type NostrIdentity,
} from './identity';

export type IdentitySource = 'derived' | 'burner' | 'imported';

/** A stored identity descriptor. No secret material — see the module header. */
export interface StoredIdentity {
  /** x-only pubkey hex — the stable id + what's shown before unlock. */
  pubkeyHex: string;
  npub: string;
  source: IdentitySource;
  /** For `derived`: the hardened NIP-06 account index. Absent otherwise. */
  account?: number;
  /** PRIVATE local label — NEVER published (kind-0 or otherwise). */
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

/** Resolve the ACTIVE identity — the one posting/DM/login should use. */
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
 * gone unless separately backed up (nsec) — the caller must confirm.
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
