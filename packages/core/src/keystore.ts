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
  /**
   * BIP39 phrase. Present after a fresh `unlock()` /
   * `createWallet()`, but **undefined** when the wallet was restored
   * from the session cache (2026-06-13 hardening — session cache no
   * longer persists the mnemonic). Call sites that need the phrase
   * (BTC/LTC PSBT signing, every Grin surface, "show seed" /
   * "export seed") must early-return with a "please re-unlock" UX
   * when this is undefined.
   */
  mnemonic?: string;
  /**
   * BIP39 seed bytes (64). Derived from mnemonic + empty passphrase.
   * Undefined on a session-cache restore (no mnemonic → no seed).
   */
  seed?: Uint8Array;
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
/**
 * Reconstruct an `UnlockedWallet` from cached leaf-key material, NO
 * mnemonic involved. Used by the session-cache flow: when the user
 * opts into "stay unlocked for N minutes," we stash the derived keys
 * + addresses + fingerprint in `chrome.storage.session` and rebuild
 * the wallet from them on popup reopen without re-prompting the
 * password.
 *
 * The returned `UnlockedWallet` has `mnemonic === undefined` and
 * `seed === undefined`. Surfaces that need either (BTC/LTC PSBT
 * signing, every Grin surface, Show Seed / Export Seed) must
 * gate-check and force a fresh password unlock.
 *
 * 2026-06-13 hardening: replaces `rebuildUnlockedFromMnemonic` which
 * required the mnemonic to be present in cache. The old function is
 * gone — call sites that referenced it are an audit finding.
 */
export function restoreUnlockedFromCache(args: {
  keys: DerivedKeys;
  addresses: WalletAddresses;
  fingerprint: string;
}): UnlockedWallet {
  return {
    keys: args.keys,
    addresses: args.addresses,
    fingerprint: args.fingerprint,
    // mnemonic + seed deliberately omitted; gate-check at the call site.
  };
}

/**
 * Hard upper bound on the auto-unlock TTL. Twenty-four hours. The
 * pre-2026-06-13 "Never" sentinel (`MAX_SAFE_INTEGER`) and the
 * negative-int "Never" convention are gone — any stored preference
 * that exceeds the cap clamps to the cap on read, so legacy v0.2.4
 * users self-heal without a migration script.
 */
export const AUTO_LOCK_MAX_MINUTES = 24 * 60;

/**
 * Normalise an arbitrary stored `autoLockMinutes` value into the
 * `[0, AUTO_LOCK_MAX_MINUTES]` band. Negative values (the legacy
 * "Never" convention) clamp to the cap; `MAX_SAFE_INTEGER` clamps
 * to the cap; non-finite or NaN values fall back to 0 (no cache).
 * Storing 0 still means "do not cache" — that path is preserved.
 */
export function clampAutoLockMinutes(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  if (raw <= 0) return raw < 0 ? AUTO_LOCK_MAX_MINUTES : 0;
  if (raw > AUTO_LOCK_MAX_MINUTES) return AUTO_LOCK_MAX_MINUTES;
  return Math.floor(raw);
}

/**
 * Storage key for the optional session-cache (used by the "auto-lock
 * after N minutes" UX). Held in a separate, ephemeral storage
 * (`chrome.storage.session` on extension, in-memory elsewhere) —
 * NEVER the persistent storage that holds the encrypted keystore.
 *
 * v0.3.0 (2026-06-13) bumped the on-disk version from `v1` (which
 * stored `{ mnemonic, fingerprint, expiresAtMs }`) to `v2` (which
 * stores `{ keys, addresses, fingerprint, expiresAtMs }`). The
 * parser rejects any payload missing `version: 2`, missing the
 * `_noMnemonic: true` brand, or containing a `mnemonic` field; on
 * rejection the cache is dropped and the user re-enters their
 * password once. No migration / dual-parse / shim — the user
 * decision was to break v0.2.4 cache compat for honest security.
 */
export const SESSION_CACHE_KEY = 'smirk_unlocked_session_cache';

/**
 * On-the-wire shape of a v2 session-cache payload. The brand field
 * `_noMnemonic` is a compile-time + runtime safeguard: any future
 * commit that accidentally adds a `mnemonic` field would need to
 * remove the brand, which would surface in code review.
 */
export interface SessionCachePayload {
  readonly version: 2;
  readonly _noMnemonic: true;
  readonly fingerprint: string;
  readonly keys: DerivedKeys;
  readonly addresses: WalletAddresses;
  /** Unix ms when this cache becomes invalid. Finite — no Infinity / "never". */
  readonly expiresAtMs: number;
}

/**
 * Parse a raw payload from `chrome.storage.session` into a
 * `SessionCachePayload`. Returns `null` for any of:
 *   - v0.2.x / pre-2026-06-13 v1 shape (mnemonic present, no version)
 *   - missing or wrong `version`
 *   - missing `_noMnemonic` brand
 *   - any `mnemonic` field at all (defence-in-depth regression guard)
 *   - structural mismatch
 * Callers should drop the stored entry on `null` so the user
 * re-enters the password once.
 */
export function parseSessionCache(raw: unknown): SessionCachePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if ('mnemonic' in r) return null;
  if (r.version !== 2) return null;
  if (r._noMnemonic !== true) return null;
  if (typeof r.fingerprint !== 'string') return null;
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
  return r as unknown as SessionCachePayload;
}

/**
 * `chrome.storage.session` (like JSON) does NOT preserve `Uint8Array` — a stored
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
 * `Uint8Array`, AND recovers a `Uint8Array` that a prior (pre-fix) write —
 * or the raw storage layer — flattened into a `{0:..,1:..}` numeric-keyed
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

/**
 * Cheap sanity check that a restored `DerivedKeys` still carries real byte
 * material (the BTC/LTC signing keys the auth bootstrap needs). Guards the
 * lost-bytes case where storage dropped the arrays entirely — the restore then
 * falls back to a password unlock instead of throwing mid-sign-in.
 */
export function derivedKeysUsable(keys: DerivedKeys | undefined): boolean {
  const ok = (u: unknown): boolean => u instanceof Uint8Array && u.length === 32;
  return !!keys && ok(keys.btc?.privateKey) && ok(keys.ltc?.privateKey);
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
      // `seed` is optional after the 2026-06-13 session-cache change
      // — a wallet restored from cache has no seed bytes to zero.
      this.cached.seed?.fill(0);
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
  tryFill(keys.nostr.privateKey);
  tryFill(keys.nostr.publicKey);
}
