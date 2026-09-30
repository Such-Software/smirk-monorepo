/**
 * Wallet keystore: encrypted seed storage + unlock state machine.
 *
 * The keystore is the single source of truth for "does this user have a
 * wallet, and is it unlocked?" Layer above HD derivation, layer below the
 * UI. Platform-agnostic: persistent encrypted state goes through a
 * `PlatformStorage`, in-memory unlocked state lives on the `WalletKeystore`
 * instance.
 *
 * Threat model and design choices:
 *
 * - **On-disk keystore is always encrypted.** The seed is encrypted
 *   under a PBKDF2-stretched password using XChaCha20-Poly1305 before
 *   being written to `storage.local`. No exceptions, no fallback,
 *   no plaintext on-disk path.
 * - **Grace-period sessions use scoped signing keys.** No mnemonic, BIP39 seed
 *   or BIP32 master root is cached. BTC/LTC account nodes, Grin spend keys and
 *   Nostr/app-specific roots preserve normal operations during the chosen TTL.
 *   These are spend authority in memory-backed session storage, cleared by
 *   explicit lock, expiry or browser shutdown. Incomplete older caches require
 *   one password unlock before the new format can be written.
 * - PBKDF2 iterations default to `PBKDF2_ITERATIONS` (600_000).
 * - Decrypted secret buffers (seed bytes) are zeroed on `lock()` /
 *   `destroy()` before being released for GC. JS strings (the
 *   mnemonic) are unfixable; we drop the reference and accept that
 *   a heap snapshot mid-flight could observe it.
 *
 * @example
 * ```ts
 * import { ChromeLocalStorage, WalletKeystore, generateMnemonicPhrase } from '@smirk/core';
 *
 * const ks = new WalletKeystore(new ChromeLocalStorage());
 *
 * // First-time setup:
 * await ks.createWallet({ mnemonic: generateMnemonicPhrase(), password: 'hunter2' });
 *
 * // Later, after SW restart:
 * const state = await ks.getState();
 * if (state.kind === 'locked') {
 *   const wallet = await ks.unlock('hunter2');
 *   // wallet.addresses.btc → "bc1q…"
 * }
 * ```
 */

import {
  PBKDF2_ITERATIONS,
  bytesToHex,
  decrypt,
  deriveKeyFromPassword,
  encrypt,
  hexToBytes,
  randomBytes,
} from './crypto';
import {
  type DerivedKeys,
  computeSeedFingerprint,
  deriveAllKeys,
  isValidMnemonic,
  mnemonicToSeed,
} from './hd';
import {
  btcAddress,
  grinSlatpackAddress,
  ltcAddress,
  wowAddress,
  xmrAddress,
} from './address';
import { HDKey } from '@scure/bip32';
import type { NostrSessionRoots } from './nostr/session-roots';
import type { PlatformStorage } from './state/platform';

const KEYSTORE_KEY = 'smirk_keystore_v1';

/** Current keystore on-disk format version. Bump on schema changes. */
export const KEYSTORE_VERSION = 1;

/**
 * Serialized, password-encrypted keystore. Safe to write to disk:
 * disclosure of this object alone does NOT compromise the wallet
 * (attacker still needs the password and at least 600_000 PBKDF2
 * iterations of guessing).
 *
 * All byte fields are hex-encoded so the whole struct round-trips
 * through `JSON.stringify` cleanly.
 */
export interface EncryptedKeystore {
  version: number;
  /** XChaCha20-Poly1305 ciphertext of the BIP39 mnemonic (UTF-8 bytes). */
  encryptedMnemonic: string;
  /** PBKDF2 salt. 16 bytes. */
  salt: string;
  /** PBKDF2 iteration count. */
  iterations: number;
  /** SHA-256(SHA-256(seed)): 64 hex chars. Identifies the wallet across
   *  re-imports without exposing the seed. Used by backend dedupe. */
  fingerprint: string;
  /** Wallet creation timestamp (ms since epoch). */
  createdAt: number;
}

/** Per-asset address strings derived from the unlocked seed. */
export interface WalletAddresses {
  btc: string;
  ltc: string;
  xmr: string;
  wow: string;
  grin: string;
}

/** BTC or LTC signing authority restricted to the BIP84 account subtree. */
export interface UtxoSessionAccount {
  privateKey: Uint8Array;
  chainCode: Uint8Array;
}

export interface GrinSessionKeys {
  extendedPrivateKey: Uint8Array;
  legacyExtendedPrivateKey: Uint8Array;
  slatepackSecret: Uint8Array;
  slatepackAddress: string;
  rewindHash: string;
}

/** Scoped operation authority; never a recovery phrase, seed or master root. */
export interface SessionSecrets {
  btc: UtxoSessionAccount;
  ltc: UtxoSessionAccount;
  grin: GrinSessionKeys;
  nostr: NostrSessionRoots;
}

/** Live wallet material. Only scoped session secrets may enter ephemeral storage. */
export interface UnlockedWallet {
  /** BIP39 phrase, present after a fresh password unlock. Removed on lock. */
  mnemonic?: string;
  /** BIP39 seed bytes, present after a fresh password unlock. Zeroed on lock. */
  seed?: Uint8Array;
  /** Present on complete grace-period sessions, derived once at password unlock. */
  sessionSecrets?: SessionSecrets;
  /** Absolute expiry of a grace-period session, never extended by restore. */
  sessionExpiresAtMs?: number;
  /** Per-asset derived keys (see `DerivedKeys` in `./hd`). */
  keys: DerivedKeys;
  /** Per-asset receive addresses. */
  addresses: WalletAddresses;
  /** Same fingerprint as the keystore, useful for sanity checks. */
  fingerprint: string;
}

export type WalletState =
  | { kind: 'empty' }
  | { kind: 'locked'; keystore: EncryptedKeystore }
  | { kind: 'unlocked'; keystore: EncryptedKeystore; wallet: UnlockedWallet };

/** Thrown by `unlock()` when the password is wrong. */
export class InvalidPasswordError extends Error {
  constructor() {
    super('Invalid password');
    this.name = 'InvalidPasswordError';
  }
}

/** Thrown when an operation requires an unlocked wallet but none is loaded. */
export class WalletLockedError extends Error {
  constructor() {
    super('Wallet is locked');
    this.name = 'WalletLockedError';
  }
}

// ============================================================================
// Pure functions (testable without storage)
// ============================================================================

/**
 * Create a new encrypted keystore from a mnemonic + password.
 *
 * Validates the mnemonic, derives a PBKDF2 key from the password with
 * a fresh random salt, encrypts the mnemonic bytes under that key with
 * XChaCha20-Poly1305, and returns a serializable struct.
 */
export async function createKeystore(
  mnemonic: string,
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<EncryptedKeystore> {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }
  if (!password) {
    throw new Error('Password must be non-empty');
  }

  const salt = randomBytes(16);
  const key = await deriveKeyFromPassword(password, salt, iterations);
  try {
    const mnemonicBytes = new TextEncoder().encode(mnemonic);
    const ciphertext = encrypt(mnemonicBytes, key);
    return {
      version: KEYSTORE_VERSION,
      encryptedMnemonic: bytesToHex(ciphertext),
      salt: bytesToHex(salt),
      iterations,
      fingerprint: computeSeedFingerprint(mnemonic),
      createdAt: Date.now(),
    };
  } finally {
    key.fill(0);
  }
}

/**
 * Decrypt a keystore with a password and derive the full unlocked
 * wallet (seed, per-asset keys, addresses).
 *
 * Throws `InvalidPasswordError` on wrong password (XChaCha20-Poly1305
 * tag failure during decryption). Throws `Error` with a different
 * message if the keystore is malformed (corrupt ciphertext, version
 * mismatch).
 */
export async function unlockKeystore(
  keystore: EncryptedKeystore,
  password: string,
): Promise<UnlockedWallet> {
  if (keystore.version !== KEYSTORE_VERSION) {
    throw new Error(`Unsupported keystore version ${keystore.version}`);
  }

  const salt = hexToBytes(keystore.salt);
  const key = await deriveKeyFromPassword(password, salt, keystore.iterations);
  try {
    let mnemonicBytes: Uint8Array;
    try {
      mnemonicBytes = decrypt(hexToBytes(keystore.encryptedMnemonic), key);
    } catch {
      // The AEAD tag check failed: wrong password (or tampered
      // ciphertext). Constant-time inside `decrypt`; we don't
      // distinguish the two cases.
      throw new InvalidPasswordError();
    }
    try {
      const mnemonic = new TextDecoder().decode(mnemonicBytes);
      const seed = mnemonicToSeed(mnemonic);
      const keys = deriveAllKeys(mnemonic, '', 3);
      const addresses = deriveAddresses(keys);
      return {
        mnemonic,
        seed,
        keys,
        addresses,
        fingerprint: keystore.fingerprint,
      };
    } finally {
      mnemonicBytes.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

/** Compute the public receive address for each supported asset. */
export function deriveAddresses(keys: DerivedKeys): WalletAddresses {
  return {
    btc: btcAddress(keys.btc.publicKey),
    ltc: ltcAddress(keys.ltc.publicKey),
    xmr: xmrAddress(keys.xmr.publicSpendKey, keys.xmr.publicViewKey),
    wow: wowAddress(keys.wow.publicSpendKey, keys.wow.publicViewKey),
    grin: grinSlatpackAddress(keys.grin.publicKey),
  };
}

/**
 * Reconstruct session material without ever recovering a phrase or seed.
 * Incomplete snapshots cannot establish WalletKeystore's unlocked state.
 */
export function restoreUnlockedFromCache(args: {
  keys: DerivedKeys;
  addresses: WalletAddresses;
  fingerprint: string;
  sessionSecrets?: SessionSecrets;
  sessionExpiresAtMs?: number;
}): UnlockedWallet {
  return {
    keys: args.keys,
    addresses: args.addresses,
    fingerprint: args.fingerprint,
    ...(args.sessionSecrets ? { sessionSecrets: args.sessionSecrets } : {}),
    ...(args.sessionExpiresAtMs !== undefined ? { sessionExpiresAtMs: args.sessionExpiresAtMs } : {}),
    // A session restores only scoped keys, never mnemonic or seed.
  };
}

/**
 * Hard upper bound on the grace-period duration. Twenty-four hours. The
 * pre-2026-06-13 "Never" sentinel (`MAX_SAFE_INTEGER`) and the
 * negative-int "Never" convention are gone; any stored preference
 * that exceeds the cap clamps to the cap on read, so legacy v0.2.4
 * users self-heal without a migration script.
 */
export const AUTO_LOCK_MAX_MINUTES = 24 * 60;

/**
 * Normalise an arbitrary stored `autoLockMinutes` value into the
 * `[0, AUTO_LOCK_MAX_MINUTES]` band. Negative values (the legacy
 * "Never" convention) clamp to the cap; `MAX_SAFE_INTEGER` clamps
 * to the cap; non-finite or NaN values fall back to 0 (lock on window close).
 */
export function clampAutoLockMinutes(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  if (raw <= 0) return raw < 0 ? AUTO_LOCK_MAX_MINUTES : 0;
  if (raw > AUTO_LOCK_MAX_MINUTES) return AUTO_LOCK_MAX_MINUTES;
  return Math.floor(raw);
}

/** In-memory grace-period cache. Version 3 requires complete scoped keys. */
export const SESSION_CACHE_KEY = 'smirk_unlocked_session_cache';

/**
 * On-the-wire shape of a complete v3 session-cache payload. The brand field
 * `_noMnemonic` is a compile-time + runtime safeguard: any future
 * commit that accidentally adds a `mnemonic` field would need to
 * remove the brand, which would surface in code review.
 */
export interface SessionCachePayload {
  readonly version: 3;
  readonly _noMnemonic: true;
  readonly fingerprint: string;
  readonly keys: DerivedKeys;
  readonly addresses: WalletAddresses;
  readonly sessionSecrets: SessionSecrets;
  /** Lock event current when this cache was admitted. */
  readonly lockId: string | null;
  /** A handoff retains the original grace-period expiry; null means window-only. */
  readonly sessionExpiresAtMs?: number | null;
  /** Unix ms when this cache becomes invalid. Finite: no Infinity / "never". */
  readonly expiresAtMs: number;
}

/**
 * Parse a raw payload from `chrome.storage.session` into a
 * `SessionCachePayload`. Returns `null` for any of:
 *   - v1 phrase caches or incomplete v2 leaf-key caches
 *   - missing or wrong `version`
 *   - missing `_noMnemonic` brand
 *   - any top-level mnemonic or BIP39 seed field
 *   - missing, malformed or foreign scoped signing roots
 *   - structural mismatch
 * Callers should drop the stored entry on `null` so the user
 * re-enters the password once.
 */
export function parseSessionCache(raw: unknown): SessionCachePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if ('mnemonic' in r || 'seed' in r) return null;
  if (r.version !== 3) return null;
  if (r._noMnemonic !== true) return null;
  if (typeof r.fingerprint !== 'string') return null;
  if (r.lockId !== null && typeof r.lockId !== 'string') return null;
  if (!sessionSecretsUsable(r.sessionSecrets, r.fingerprint)) return null;
  if (r.sessionExpiresAtMs !== undefined && r.sessionExpiresAtMs !== null
    && (typeof r.sessionExpiresAtMs !== 'number' || !Number.isFinite(r.sessionExpiresAtMs))) return null;
  if (typeof r.expiresAtMs !== 'number' || !Number.isFinite(r.expiresAtMs)) {
    return null;
  }
  if (!r.keys || typeof r.keys !== 'object') return null;
  if (!r.addresses || typeof r.addresses !== 'object') return null;
  // Validate each asset is actually present. A corrupted {keys:{}, addresses:{}}
  // would otherwise pass and crash downstream on keys.btc.publicKey etc.
  const keys = r.keys as Record<string, unknown>;
  const addresses = r.addresses as Record<string, unknown>;
  for (const asset of ['btc', 'ltc', 'xmr', 'wow', 'grin'] as const) {
    if (!keys[asset] || typeof keys[asset] !== 'object') return null;
    if (typeof addresses[asset] !== 'string') return null;
  }
  // The cached nostr identity keypair (account 0) rides inside `keys` but has
  // no `addresses` entry, so it is validated on its own: presence + object
  // shape. A pre-nostr v2 cache (written before this field existed) is
  // rejected here and self-heals with a single re-unlock.
  if (!keys.nostr || typeof keys.nostr !== 'object') return null;
  // Money gate G10: the BTC/LTC gap-limit fresh-address feature derives
  // receive/change addresses on a warm session from the account xpub
  // (`keys.btc.accountXpub` / `keys.ltc.accountXpub`). A pre-xpub cache
  // (written before this field existed) lacks it; rather than crash later
  // when the address book asks for the xpub, reject the whole cache here so
  // the wallet re-derives everything from a single fresh password unlock.
  // The unlock path (`unlockKeystore` → `deriveAllKeys(_, _, 3)`) always
  // populates the xpub, so a freshly-written cache always passes.
  for (const asset of ['btc', 'ltc'] as const) {
    const k = keys[asset] as Record<string, unknown> | undefined;
    if (!k || typeof k.accountXpub !== 'string' || k.accountXpub.length === 0) {
      return null;
    }
  }
  return r as unknown as SessionCachePayload;
}

/**
 * `chrome.storage.session` (like JSON) does NOT preserve `Uint8Array`: a stored
 * key comes back as a plain numeric-keyed object, so downstream signing throws
 * "private key must be hex string or Uint8Array" and an auto-unlock (session
 * cache) restore fails even though the user never had to sign in. These two
 * helpers make the round-trip lossless: every `Uint8Array` is written as
 * `{ __u8: <hex> }` (a plain string, which every storage backend preserves) and
 * revived back on read.
 */
export function serializeForSessionCache(value: unknown): unknown {
  if (value instanceof Uint8Array) return { __u8: bytesToHex(value) };
  if (Array.isArray(value)) return value.map(serializeForSessionCache);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeForSessionCache(v);
    }
    return out;
  }
  return value;
}

/**
 * Inverse of {@link serializeForSessionCache}. Revives `{ __u8: hex }` to a
 * `Uint8Array`, AND recovers a `Uint8Array` that a prior (pre-fix) write,
 * or the raw storage layer, flattened into a `{0:..,1:..}` numeric-keyed
 * object, so an already-broken cache self-heals instead of stranding the user.
 */
export function reviveForSessionCache(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveForSessionCache);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.__u8 === 'string') return hexToBytes(o.__u8);
    const ks = Object.keys(o);
    if (
      ks.length > 0 &&
      ks.every((k, i) => k === String(i)) &&
      Object.values(o).every(
        (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255,
      )
    ) {
      return Uint8Array.from(Object.values(o) as number[]);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = reviveForSessionCache(v);
    return out;
  }
  return value;
}

/** Require usable byte material for every supported signing and encryption key. */
export function derivedKeysUsable(keys: DerivedKeys | undefined): boolean {
  const bytes = (u: unknown, length: number): boolean =>
    u instanceof Uint8Array && u.length === length && u.some((byte) => byte !== 0);
  if (!keys) return false;
  for (const asset of ['btc', 'ltc'] as const) {
    if (!bytes(keys[asset]?.privateKey, 32) || !bytes(keys[asset]?.publicKey, 33)) return false;
  }
  for (const asset of ['xmr', 'wow'] as const) {
    const key = keys[asset];
    if (!key || !bytes(key.privateSpendKey, 32) || !bytes(key.privateViewKey, 32)
      || !bytes(key.publicSpendKey, 32) || !bytes(key.publicViewKey, 32)) return false;
  }
  for (const asset of ['grin', 'nostr'] as const) {
    if (!bytes(keys[asset]?.privateKey, 32) || !bytes(keys[asset]?.publicKey, 32)) return false;
  }
  return bytes(keys.enc?.xmr.seed, 32) && bytes(keys.enc?.xmr.publicKey, 32)
    && bytes(keys.enc?.wow.seed, 32) && bytes(keys.enc?.wow.publicKey, 32);
}

// ============================================================================
// Stateful wrapper
// ============================================================================

/**
 * Wraps a `PlatformStorage` with the wallet state machine.
 *
 * Lifecycle:
 * - `empty`     : no keystore on disk yet (fresh install).
 * - `locked`    : keystore present, password not entered this session.
 * - `unlocked`  : password entered, keys + addresses available.
 *
 * Transitions:
 * - `createWallet` :  empty/locked → unlocked
 * - `unlock`       :  locked → unlocked
 * - `lock`         :  unlocked → locked  (keys zeroed, dropped from memory)
 * - `destroy`      :  any → empty  (also zeroes in-memory state)
 *
 * A new wallet-window instance starts locked. Restarting a background worker
 * does not affect an existing window's in-memory keystore.
 */
export class WalletKeystore {
  private cached: UnlockedWallet | null = null;
  private lockGeneration = 0;

  constructor(private storage: PlatformStorage) {}

  /** Capture before asynchronous session reads so a later lock invalidates them. */
  captureSessionGeneration(): number {
    return this.lockGeneration;
  }

  /** Admit detached scoped material without any await between validation and use. */
  admitRestoredSession(wallet: UnlockedWallet, generation: number, fingerprint: string, epochCurrent: boolean): UnlockedWallet | null {
    if (!epochCurrent || this.cached || generation !== this.lockGeneration || wallet.fingerprint !== fingerprint
      || wallet.mnemonic !== undefined || wallet.seed !== undefined
      || !hasCompleteSigningMaterial(wallet)
      || (wallet.sessionExpiresAtMs !== undefined
        && (!Number.isFinite(wallet.sessionExpiresAtMs) || Date.now() >= wallet.sessionExpiresAtMs))) {
      if (wallet !== this.cached) clearUnlockedWallet(wallet);
      return null;
    }
    this.cached = wallet;
    return wallet;
  }

  /** Read the keystore from storage and combine with in-memory state. */
  async getState(): Promise<WalletState> {
    const keystore = await this.loadKeystore();
    if (!keystore) {
      await this.lock();
      return { kind: 'empty' };
    }
    if (this.cached && (
      !hasCompleteSigningMaterial(this.cached) || this.cached.fingerprint !== keystore.fingerprint
      || (this.cached.sessionExpiresAtMs !== undefined && Date.now() >= this.cached.sessionExpiresAtMs)
    )) await this.lock();
    if (this.cached) return { kind: 'unlocked', keystore, wallet: this.cached };
    return { kind: 'locked', keystore };
  }

  /**
   * Encrypt the supplied mnemonic under `password` and persist. Leaves
   * the wallet in the `unlocked` state.
   *
   * If a keystore already exists, this throws: the caller must
   * `destroy()` first to confirm the user really wants to replace it.
   */
  async createWallet(args: {
    mnemonic: string;
    password: string;
    iterations?: number;
  }): Promise<UnlockedWallet> {
    const generation = this.lockGeneration;
    const existing = await this.loadKeystore();
    if (existing) {
      throw new Error(
        'A wallet already exists in this storage. Destroy it first.',
      );
    }
    const keystore = await createKeystore(
      args.mnemonic,
      args.password,
      args.iterations ?? PBKDF2_ITERATIONS,
    );
    await this.storage.set(KEYSTORE_KEY, keystore);
    const wallet = await unlockKeystore(keystore, args.password);
    if (generation !== this.lockGeneration) {
      clearUnlockedWallet(wallet);
      throw new WalletLockedError();
    }
    this.cached = wallet;
    return wallet;
  }

  /** Decrypt the on-disk keystore and cache the result in memory. */
  async unlock(password: string): Promise<UnlockedWallet> {
    const generation = this.lockGeneration;
    const keystore = await this.loadKeystore();
    if (!keystore) {
      throw new Error('No wallet to unlock — create one first.');
    }
    const wallet = await unlockKeystore(keystore, password);
    if (generation !== this.lockGeneration) {
      clearUnlockedWallet(wallet);
      throw new WalletLockedError();
    }
    this.cached = wallet;
    return wallet;
  }

  /** Verify an operation password without changing the live wallet or deadline. */
  async verifyPassword(password: string, expectedWallet: UnlockedWallet = this.getUnlocked()): Promise<void> {
    this.assertUnlockedWallet(expectedWallet);
    const generation = this.lockGeneration;
    const keystore = await this.loadKeystore();
    if (!keystore || keystore.fingerprint !== expectedWallet.fingerprint) throw new WalletLockedError();
    const temporary = await unlockKeystore(keystore, password);
    try {
      if (generation !== this.lockGeneration) throw new WalletLockedError();
      this.assertUnlockedWallet(expectedWallet);
    } finally {
      clearUnlockedWallet(temporary);
    }
  }

  /** Reveal only to the current session, without replacing it or renewing its expiry. */
  async readRecoveryPhrase(password: string, expectedWallet: UnlockedWallet = this.getUnlocked()): Promise<string> {
    this.assertUnlockedWallet(expectedWallet);
    const generation = this.lockGeneration;
    const keystore = await this.loadKeystore();
    if (!keystore || keystore.fingerprint !== expectedWallet.fingerprint) throw new WalletLockedError();
    const temporary = await unlockKeystore(keystore, password);
    try {
      if (generation !== this.lockGeneration) throw new WalletLockedError();
      this.assertUnlockedWallet(expectedWallet);
      if (!temporary.mnemonic) throw new Error('The encrypted wallet did not contain a recovery phrase.');
      return temporary.mnemonic;
    } finally {
      clearUnlockedWallet(temporary);
    }
  }

  /** An approval belongs to this exact live session, never a later unlock. */
  assertUnlockedWallet(expectedWallet: UnlockedWallet): void {
    if (this.getUnlocked() !== expectedWallet) throw new WalletLockedError();
  }

  /**
   * Drop the cached unlocked state. The on-disk keystore stays.
   * Zeroes the seed buffer before releasing.
   */
  async lock(): Promise<void> {
    this.lockGeneration += 1;
    if (this.cached) clearUnlockedWallet(this.cached);
    this.cached = null;
  }

  /** Wipe the keystore entirely. Use for "forget wallet" / re-import. */
  async destroy(): Promise<void> {
    await this.lock();
    await this.storage.remove(KEYSTORE_KEY);
  }

  /**
   * Rotate the password protecting the keystore. Decrypts with the
   * current password (verifying it via the AEAD tag), re-encrypts
   * the same mnemonic under a freshly-derived key from the new
   * password + a NEW salt, and writes the new ciphertext to storage.
   *
   * Throws `InvalidPasswordError` on wrong current password (same
   * as `unlock`), so callers can render the same "wrong password"
   * UX. Throws if no wallet exists.
   *
   * Atomicity: we compute the new ciphertext fully before writing,
   * so a thrown error mid-flight leaves the old keystore untouched.
   * If the storage write itself fails after we've computed the new
   * bytes, the on-disk state is the OLD ciphertext + the user's
   * OLD password, recoverable by retrying. There is no "half-
   * rotated" state on disk.
   *
   * Leaves the in-memory cached wallet alone: the unlocked
   * `UnlockedWallet` doesn't depend on the encryption key, only on
   * the underlying mnemonic. Subsequent `unlock()` calls require
   * the new password.
   *
   * Iterations default to `PBKDF2_ITERATIONS` (600_000) for the new
   * keystore; the rotation is also the path forward for legacy
   * v0.2.x wallets that were created at 100_000 iterations, if we
   * ever wire an opportunistic re-encrypt on first unlock.
   */
  async changePassword(args: {
    currentPassword: string;
    newPassword: string;
    iterations?: number;
  }): Promise<void> {
    const keystore = await this.loadKeystore();
    if (!keystore) {
      throw new Error('No wallet to change password on — create one first.');
    }
    if (!args.newPassword) {
      throw new Error('New password must be non-empty');
    }
    // Verify current password by decrypting (throws InvalidPasswordError
    // on AEAD mismatch). We discard the decrypted wallet: the caller
    // doesn't need it; in-memory state stays whatever it was.
    const unlocked = await unlockKeystore(keystore, args.currentPassword);
    // Sanity: `unlockKeystore` is the fresh-unlock path and must
    // populate `mnemonic` + `seed`. The optional-on-the-type marker
    // exists for the session-cache restore path; we never hit that
    // here. Throwing turns an invariant violation into a clear
    // error instead of a `String(undefined)` keystore corruption.
    if (!unlocked.mnemonic || !unlocked.seed) {
      throw new Error(
        'changePassword: unlockKeystore returned a wallet without mnemonic/seed (invariant violation)',
      );
    }
    try {
      const next = await createKeystore(
        unlocked.mnemonic,
        args.newPassword,
        args.iterations ?? PBKDF2_ITERATIONS,
      );
      // Preserve creation timestamp + fingerprint so backend dedupe
      // and birthday-restore behaviour don't shift just because the
      // user rotated their password. Only the encryption envelope
      // changes.
      const preserved: EncryptedKeystore = {
        ...next,
        fingerprint: keystore.fingerprint,
        createdAt: keystore.createdAt,
      };
      await this.storage.set(KEYSTORE_KEY, preserved);
    } finally {
      // Zero the temporarily-decrypted seed bytes even on the
      // success path: we held a plaintext seed for the duration
      // of the rotation, and it should not outlive this call.
      unlocked.seed.fill(0);
      zeroKeysIfPossible(unlocked.keys);
    }
  }

  /** Get the cached unlocked wallet, or throw `WalletLockedError`. */
  getUnlocked(): UnlockedWallet {
    if (!this.cached || !hasCompleteSigningMaterial(this.cached)
      || (this.cached.sessionExpiresAtMs !== undefined && Date.now() >= this.cached.sessionExpiresAtMs)) {
      if (this.cached) clearUnlockedWallet(this.cached);
      this.cached = null;
      throw new WalletLockedError();
    }
    return this.cached;
  }

  private async loadKeystore(): Promise<EncryptedKeystore | null> {
    const raw = await this.storage.get(KEYSTORE_KEY);
    if (!raw) return null;
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof (raw as { version?: unknown }).version !== 'number'
    ) {
      throw new Error('Stored keystore is malformed.');
    }
    return raw as EncryptedKeystore;
  }
}

/** Complete authority for advertised operations, fresh or restored. */
export function hasCompleteSigningMaterial(wallet: UnlockedWallet): boolean {
  if (!derivedKeysUsable(wallet.keys)) return false;
  if (typeof wallet.mnemonic === 'string' && isValidMnemonic(wallet.mnemonic)
    && wallet.seed instanceof Uint8Array && wallet.seed.length === 64
    && wallet.seed.some((byte) => byte !== 0)) return true;
  return sessionSecretsUsable(wallet.sessionSecrets, wallet.fingerprint);
}

/** Reject truncated roots and any BIP32 root outside its intended subtree. */
export function sessionSecretsUsable(raw: unknown, fingerprint: string): raw is SessionSecrets {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as SessionSecrets;
  const bytes = (v: unknown, length: number): boolean =>
    v instanceof Uint8Array && v.length === length && v.some((byte) => byte !== 0);
  for (const asset of ['btc', 'ltc'] as const) {
    if (!bytes(s[asset]?.privateKey, 32) || !bytes(s[asset]?.chainCode, 32)) return false;
  }
  if (!bytes(s.grin?.extendedPrivateKey, 64) || !bytes(s.grin?.legacyExtendedPrivateKey, 64)
    || !bytes(s.grin?.slatepackSecret, 32) || typeof s.grin?.slatepackAddress !== 'string'
    || !s.grin.slatepackAddress.startsWith('grin1') || !/^[0-9a-f]{64}$/.test(s.grin.rewindHash)) return false;
  if (!s.nostr || s.nostr.fingerprint !== fingerprint || !bytes(s.nostr.vaultKey, 32)) return false;
  try {
    for (const [root, index] of [
      [s.nostr.identityRoot, 1237], [s.nostr.originRoot, 4], [s.nostr.appEncryptionRoot, 3],
    ] as const) {
      const node = HDKey.fromExtendedKey(root);
      if (!node.privateKey || node.depth !== 2 || node.index !== 0x80000000 + index) return false;
      node.wipePrivateData();
    }
  } catch { return false; }
  return true;
}

/** Revoke shared wallet references as well as the keystore's own reference. */
function clearUnlockedWallet(wallet: UnlockedWallet): void {
  wallet.seed?.fill(0);
  delete wallet.seed;
  delete wallet.mnemonic;
  zeroKeysIfPossible(wallet.keys);
  if (wallet.sessionSecrets) {
    const secrets = wallet.sessionSecrets;
    for (const bytes of [
      secrets.btc?.privateKey, secrets.btc?.chainCode,
      secrets.ltc?.privateKey, secrets.ltc?.chainCode,
      secrets.grin?.extendedPrivateKey, secrets.grin?.legacyExtendedPrivateKey,
      secrets.grin?.slatepackSecret, secrets.nostr?.vaultKey,
    ]) {
      if (bytes instanceof Uint8Array) bytes.fill(0);
    }
    if (secrets.nostr) {
      secrets.nostr.identityRoot = '';
      secrets.nostr.originRoot = '';
      secrets.nostr.appEncryptionRoot = '';
    }
    delete wallet.sessionSecrets;
  }
  delete wallet.sessionExpiresAtMs;
}

function zeroKeysIfPossible(keys: DerivedKeys): void {
  const tryFill = (b: Uint8Array | undefined): void => {
    if (b) {
      try {
        b.fill(0);
      } catch {
        /* immutable typed array: best effort only */
      }
    }
  };
  tryFill(keys.btc?.privateKey);
  tryFill(keys.ltc?.privateKey);
  tryFill(keys.xmr?.privateSpendKey);
  tryFill(keys.xmr?.privateViewKey);
  tryFill(keys.wow?.privateSpendKey);
  tryFill(keys.wow?.privateViewKey);
  tryFill(keys.grin?.privateKey);
  tryFill(keys.nostr?.privateKey);
  tryFill(keys.nostr?.publicKey);
  tryFill(keys.enc?.xmr.seed);
  tryFill(keys.enc?.wow.seed);
}
