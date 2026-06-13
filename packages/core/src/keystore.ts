/**
 * Wallet keystore — encrypted seed storage + unlock state machine.
 *
 * The keystore is the single source of truth for "does this user have a
 * wallet, and is it unlocked?" Layer above HD derivation, layer below the
 * UI. Platform-agnostic: persistent encrypted state goes through a
 * `PlatformStorage`, in-memory unlocked state lives on the `WalletKeystore`
 * instance.
 *
 * Threat model and design choices (informed by 2026-05-10 audit, see
 * `docs/SECURITY_AUDIT.md`; auto-unlock cache caveat documented in
 * `docs/SECURITY_LOG.md` 2026-06-13):
 *
 * - **On-disk keystore is always encrypted.** The seed is encrypted
 *   under a PBKDF2-stretched password using XChaCha20-Poly1305 before
 *   being written to `storage.local`. No exceptions, no fallback,
 *   no plaintext on-disk path.
 * - **Auto-unlock cache (opt-in).** When the user picks an
 *   `autoLockMinutes > 0` setting, the unlocked wallet — including
 *   the plaintext mnemonic — is cached in `chrome.storage.session`
 *   so popup reopens (and SW restarts within the window) skip the
 *   password prompt. See `SESSION_CACHE_KEY` /
 *   `rebuildUnlockedFromMnemonic` below.
 *   - `chrome.storage.session` is **in-memory only** (never written
 *     to disk by Chrome) and is cleared automatically on browser
 *     close.
 *   - It is partitioned per extension ID by Chrome: another
 *     co-resident extension cannot read this extension's
 *     `storage.session`.
 *   - When the user picks "Never" — encoded as the
 *     `Number.MAX_SAFE_INTEGER` sentinel in `autoLockMinutes` — the
 *     cache lives until the browser process exits.
 *   - When the user picks `autoLockMinutes === 0` ("require password
 *     every time"), the cache is **not** written and the legacy
 *     re-prompt-on-SW-restart behaviour applies.
 * - **Threat model for the auto-unlock cache.** The remaining
 *   exposure is process-memory disclosure: a debugger attached to the
 *   browser, OS-level malware with the right privileges, or a heap
 *   snapshot taken mid-flight can read the cached mnemonic. This is
 *   the same level of exposure as the popup's own in-memory unlocked
 *   state — i.e., we are not making the threat model worse than
 *   "the wallet is currently unlocked," we are *extending the
 *   duration* of that exposure window for the user's convenience.
 *   A co-resident malicious extension is **not** in scope for this
 *   cache (Chrome's per-extension partition blocks it).
 * - **Tracked for v0.3.x re-architecture.** Replace the mnemonic
 *   cache with a wrapped-key approach: the unlock ceremony derives
 *   a short-lived wrapping key, stores only the wrapped seed in
 *   `storage.session`, and the mnemonic string is dropped after
 *   keystore creation. The seed then never leaves the unlock
 *   ceremony, and a debugger-on-running-process attack recovers a
 *   wrapped blob plus an in-memory key — not the recovery phrase
 *   itself. See `docs/SECURITY_LOG.md` 2026-06-13 entry for the
 *   design sketch.
 * - PBKDF2 iterations default to `PBKDF2_ITERATIONS` (600_000).
 * - Decrypted secret buffers (seed bytes) are zeroed on `lock()` /
 *   `destroy()` before being released for GC. JS strings (the
 *   mnemonic) are unfixable — we drop the reference and accept that
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
import type { PlatformStorage } from './state/platform';

const KEYSTORE_KEY = 'smirk_keystore_v1';

/** Current keystore on-disk format version. Bump on schema changes. */
export const KEYSTORE_VERSION = 1;

/**
 * Serialized, password-encrypted keystore. Safe to write to disk —
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
  /** SHA-256(SHA-256(seed)) — 64 hex chars. Identifies the wallet across
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

/**
 * In-memory unlocked wallet state. Holds the seed and per-asset key
 * material — must not be serialized to any persistent storage.
 *
 * Held by reference inside `WalletKeystore` after a successful
 * `unlock()`; released when `lock()` or `destroy()` is called.
 */
export interface UnlockedWallet {
  mnemonic: string;
  /** BIP39 seed bytes (64). Derived from mnemonic + empty passphrase. */
  seed: Uint8Array;
  /** Per-asset derived keys (see `DerivedKeys` in `./hd`). */
  keys: DerivedKeys;
  /** Per-asset receive addresses. */
  addresses: WalletAddresses;
  /** Same fingerprint as the keystore — useful for sanity checks. */
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
      // The AEAD tag check failed — wrong password (or tampered
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
 * Rebuild a full `UnlockedWallet` directly from a mnemonic (skips PBKDF2
 * decryption). Used by the session-cache flow: when the user opts into
 * "stay unlocked for N minutes," we stash the plaintext mnemonic in
 * `chrome.storage.session` and reconstruct the wallet from it on popup
 * reopen without re-prompting the password.
 *
 * `fingerprint` is supplied separately so we don't need to recompute it
 * (the encrypted keystore already has it).
 */
export function rebuildUnlockedFromMnemonic(
  mnemonic: string,
  fingerprint: string,
): UnlockedWallet {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic in cache');
  }
  const seed = mnemonicToSeed(mnemonic);
  const keys = deriveAllKeys(mnemonic, '', 3);
  const addresses = deriveAddresses(keys);
  return { mnemonic, seed, keys, addresses, fingerprint };
}

/**
 * Storage key for the optional session-cache (used by the "auto-lock
 * after N minutes" UX). Held in a separate, ephemeral storage
 * (`chrome.storage.session` on extension, in-memory elsewhere) — NEVER
 * the persistent storage that holds the encrypted keystore.
 */
export const SESSION_CACHE_KEY = 'smirk_unlocked_session_cache';

export interface SessionCacheEntry {
  mnemonic: string;
  fingerprint: string;
  /** Unix ms when this cache becomes invalid. `Infinity` for "never". */
  expiresAtMs: number;
}

// ============================================================================
// Stateful wrapper
// ============================================================================

/**
 * Wraps a `PlatformStorage` with the wallet state machine.
 *
 * Lifecycle:
 * - `empty`     — no keystore on disk yet (fresh install).
 * - `locked`    — keystore present, password not entered this session.
 * - `unlocked`  — password entered, keys + addresses available.
 *
 * Transitions:
 * - `createWallet` :  empty/locked → unlocked
 * - `unlock`       :  locked → unlocked
 * - `lock`         :  unlocked → locked  (keys zeroed, dropped from memory)
 * - `destroy`      :  any → empty  (also zeroes in-memory state)
 *
 * On MV3 service-worker restart, the in-memory cached state is lost
 * and `getState()` re-reads from storage — which means a previously
 * `unlocked` wallet shows up as `locked` until the user re-enters
 * their password. That's intentional (see file header).
 */
export class WalletKeystore {
  private cached: UnlockedWallet | null = null;

  constructor(private storage: PlatformStorage) {}

  /** Read the keystore from storage and combine with in-memory state. */
  async getState(): Promise<WalletState> {
    const keystore = await this.loadKeystore();
    if (!keystore) return { kind: 'empty' };
    if (this.cached) {
      return { kind: 'unlocked', keystore, wallet: this.cached };
    }
    return { kind: 'locked', keystore };
  }

  /**
   * Encrypt the supplied mnemonic under `password` and persist. Leaves
   * the wallet in the `unlocked` state.
   *
   * If a keystore already exists, this throws — the caller must
   * `destroy()` first to confirm the user really wants to replace it.
   */
  async createWallet(args: {
    mnemonic: string;
    password: string;
    iterations?: number;
  }): Promise<UnlockedWallet> {
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
    this.cached = wallet;
    return wallet;
  }

  /** Decrypt the on-disk keystore and cache the result in memory. */
  async unlock(password: string): Promise<UnlockedWallet> {
    const keystore = await this.loadKeystore();
    if (!keystore) {
      throw new Error('No wallet to unlock — create one first.');
    }
    const wallet = await unlockKeystore(keystore, password);
    this.cached = wallet;
    return wallet;
  }

  /**
   * Drop the cached unlocked state. The on-disk keystore stays.
   * Zeroes the seed buffer before releasing.
   */
  async lock(): Promise<void> {
    if (this.cached) {
      this.cached.seed.fill(0);
      // Best-effort key zeroization. Some private-key fields are
      // immutable typed arrays from `@noble/curves`; we zero what we can.
      zeroKeysIfPossible(this.cached.keys);
      this.cached = null;
    }
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
   * OLD password — recoverable by retrying. There is no "half-
   * rotated" state on disk.
   *
   * Leaves the in-memory cached wallet alone — the unlocked
   * `UnlockedWallet` doesn't depend on the encryption key, only on
   * the underlying mnemonic. Subsequent `unlock()` calls require
   * the new password.
   *
   * Iterations default to `PBKDF2_ITERATIONS` (600_000) for the new
   * keystore — the rotation is also the path forward for legacy
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
    // on AEAD mismatch). We discard the decrypted wallet — the caller
    // doesn't need it; in-memory state stays whatever it was.
    const unlocked = await unlockKeystore(keystore, args.currentPassword);
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
      // success path — we held a plaintext seed for the duration
      // of the rotation, and it should not outlive this call.
      unlocked.seed.fill(0);
      zeroKeysIfPossible(unlocked.keys);
    }
  }

  /** Get the cached unlocked wallet, or throw `WalletLockedError`. */
  getUnlocked(): UnlockedWallet {
    if (!this.cached) throw new WalletLockedError();
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

function zeroKeysIfPossible(keys: DerivedKeys): void {
  const tryFill = (b: Uint8Array | undefined): void => {
    if (b) {
      try {
        b.fill(0);
      } catch {
        /* immutable typed array — best effort only */
      }
    }
  };
  tryFill(keys.btc.privateKey);
  tryFill(keys.ltc.privateKey);
  tryFill(keys.xmr.privateSpendKey);
  tryFill(keys.xmr.privateViewKey);
  tryFill(keys.wow.privateSpendKey);
  tryFill(keys.wow.privateViewKey);
  tryFill(keys.grin.privateKey);
}
