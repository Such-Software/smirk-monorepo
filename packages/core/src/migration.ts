/**
 * v0.2 -> v0.3 wallet migration (FUND-CRITICAL).
 *
 * A v0.2 user upgrading in place must not lose funds or identity. The seed +
 * Nostr identity are seed-derived and carry automatically; only two things
 * differ: (1) the keystore envelope (legacy `walletState` -> `smirk_keystore_v1`)
 * and (2) BTC/LTC derivation (legacy `m/44'` -> v0.3 `m/84'`), so legacy coins
 * sit at an address the v0.3 wallet doesn't watch.
 *
 * Crypto note (verified, load-bearing): the legacy v0.2 seal is
 * **XChaCha20-Poly1305 + PBKDF2-SHA256**, BYTE-IDENTICAL to v0.3 core's
 * `decryptPrivateKey`. So the migrator REUSES core crypto — no AES-GCM, ever.
 * The only value that crosses the version boundary is the iteration count
 * (absent => the 100k legacy cohort, NOT 600k).
 *
 * Design = CONVERGENCE, not a one-shot: the keystore reseal is one-shot
 * (detect-gated), but the identity-link and the BTC/LTC sweep are idempotent
 * post-unlock steps that no-op when already done — so a fresh v0.2 wallet, a
 * half-migrated wallet, and an intermediate dev-build wallet all converge to the
 * same end state.
 */
import { decryptPrivateKey, PBKDF2_ITERATIONS_LEGACY } from './crypto';
import { btcAddress, ltcAddress } from './address';
import { deriveLegacyBtcLtcKey, isValidMnemonic, mnemonicToSeed } from './hd';
import type { PlatformStorage } from './state/platform';

/** chrome.storage.local key the LEGACY v0.2 wallet persisted under. */
export const LEGACY_WALLET_KEY = 'walletState';
/** chrome.storage.local key the v0.3 keystore persists under. */
export const V03_KEYSTORE_KEY = 'smirk_keystore_v1';

/**
 * Read-only view of the legacy v0.2 `walletState` fields this migration reads.
 * The `encryptedSeed` plaintext IS the mnemonic PHRASE (v0.2 sealed the phrase),
 * so we decrypt it and re-seal that phrase — never the raw bip39 seed.
 */
export interface LegacyWalletState {
  /** Hex XChaCha20-Poly1305 ciphertext of the mnemonic phrase (nonce||ct||tag). */
  encryptedSeed?: string;
  /** Hex 16-byte PBKDF2 salt (the single master salt). */
  seedSalt?: string;
  /** PBKDF2 iterations. ABSENT => 100000 (legacy cohort); else the stored count. */
  pbkdf2Iterations?: number;
  /** XMR/WOW/Grin key version (informational; identity carries via the seed). */
  derivationVersion?: 1 | 2 | 3;
  /** Sealed 64-byte bip39 seed. Unused for the reseal (we re-derive from the phrase). */
  encryptedBip39Seed?: string;
}

/**
 * Detect an UPGRADING v0.2 user: a legacy `walletState` with a sealed seed AND
 * no v0.3 keystore yet. Idempotent, no writes. The moment the v0.3 keystore is
 * durably written the predicate flips false, so a crash-retry re-enters as a
 * normal v0.3 locked wallet and never re-migrates.
 */
export async function detectLegacyWallet(
  storage: PlatformStorage,
): Promise<boolean> {
  const legacy = await storage.get<LegacyWalletState>(LEGACY_WALLET_KEY);
  const ks = await storage.get<unknown>(V03_KEYSTORE_KEY);
  return (
    typeof legacy?.encryptedSeed === 'string' &&
    legacy.encryptedSeed.length > 0 &&
    ks == null
  );
}

/**
 * Decrypt the legacy v0.2 seed to its mnemonic PHRASE. Reuses v0.3 core
 * `decryptPrivateKey` (byte-identical to the legacy seal). The iterations
 * selector is LOAD-BEARING: an absent `pbkdf2Iterations` means the 100k cohort,
 * NOT 600k — hardcoding 600k rejects every pre-upgrade wallet. Throws on a wrong
 * password / corruption (AEAD tag verify) or an invalid decoded mnemonic.
 */
export async function decryptLegacyMnemonic(
  legacy: LegacyWalletState,
  password: string,
): Promise<string> {
  if (!legacy.encryptedSeed || !legacy.seedSalt) {
    throw new Error('legacy wallet has no sealed seed');
  }
  const iterations = legacy.pbkdf2Iterations ?? PBKDF2_ITERATIONS_LEGACY;
  const bytes = await decryptPrivateKey(
    legacy.encryptedSeed,
    legacy.seedSalt,
    password,
    iterations,
  );
  const mnemonic = new TextDecoder().decode(bytes).trim().replace(/\s+/g, ' ');
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('decrypted data is not a valid BIP-39 mnemonic');
  }
  return mnemonic;
}

/** SLIP-44 coin types for the UTXO chains the sweep touches. */
const COIN_TYPE = { btc: 0, ltc: 2 } as const;

/**
 * The legacy (pre-v0.3) BTC/LTC key + P2WPKH address at `m/44'/coin'/0'/0/0` —
 * the Smirk-specific combination v0.2.x used. For MIGRATION only: detect funds
 * sitting at the old address and sweep them to the v0.3 `m/84'` address. This is
 * a DIFFERENT child key than v0.3, so it must be derived on the `m/44'` path
 * explicitly (never via `deriveAllKeys`, which would also touch buggy v2
 * XMR/WOW keys).
 */
export function legacyBtcLtcKey(
  mnemonic: string,
  asset: 'btc' | 'ltc',
): { privateKey: Uint8Array; publicKey: Uint8Array; address: string } {
  const seed = mnemonicToSeed(mnemonic);
  const key = deriveLegacyBtcLtcKey(seed, COIN_TYPE[asset]);
  const address =
    asset === 'btc' ? btcAddress(key.publicKey) : ltcAddress(key.publicKey);
  return { ...key, address };
}
