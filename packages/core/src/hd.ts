/**
 * Hierarchical-Deterministic (HD) wallet utilities.
 *
 * BIP39 mnemonic ↔ seed, plus per-asset derivation:
 *
 * | Asset | v3 path                  | Curve / scheme                  |
 * |-------|--------------------------|---------------------------------|
 * | BTC   | `m/84'/0'/0'/0/0`        | secp256k1, BIP84 native-segwit  |
 * | LTC   | `m/84'/2'/0'/0/0`        | secp256k1, BIP84 native-segwit  |
 * | XMR   | `m/44'/128'/0'/0/0`      | secp256k1 → mod l (Cake-compat) |
 * | WOW   | `m/44'/2086'/0'/0/0`     | secp256k1 → mod l               |
 * | Grin  | (separate — see below)   | ed25519 over legacy `SHA256(master + "smirk:grin:v1")` |
 *
 * BTC/LTC switched from `m/44'/coin'/...` to `m/84'/coin'/...` on
 * 2026-05-11 — the older path produced P2WPKH bech32 addresses at a
 * non-standard derivation that no off-the-shelf wallet (Sparrow,
 * Electrum, Cake, Bitcoin Core) reproduces from a seed import. v0.3
 * standardizes on BIP84 so a Smirk seed restored anywhere matches.
 * `deriveLegacyBtcLtcKey` keeps the old path available for the
 * `seed-to-keys` recovery script.
 *
 * Three derivation generations exist and we keep all of them so old
 * wallets can be swept and migrated:
 *
 *   v1: legacy custom SHA256(seed || `smirk:{coin}:v1`) — XMR/WOW
 *   v2: buggy SLIP-10 ed25519 at the 3-level path `m/44'/coin'/0'`
 *   v3: BIP32 secp256k1 at `m/44'/coin'/0'/0/0` (current, Cake-compatible)
 *
 * Grin gets its own treatment in `grin-ext` (HMAC-SHA512 with key
 * `"IamVoldemort"` over the raw BIP39 entropy — matches grin-wallet
 * and Grim). The `deriveGrinKey` here is the **legacy v1** code path,
 * preserved verbatim so existing Smirk wallets keep deriving the same
 * slatepack address. New Grin wallet flows should call into
 * `@smirk/wasm`'s `grin.deriveExtendedKey` / `grin.slatepackAddress`.
 */

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { keccak_256 } from '@noble/hashes/sha3';
import { ed25519 } from '@noble/curves/ed25519';
import { schnorr } from '@noble/curves/secp256k1';
import { registry } from '@smirk/assets';

/**
 * SLIP-0044 BIP44 coin types, sourced from the asset registry.
 *
 * Adding a new chain to the wallet means adding it to `@smirk/assets`
 * — the value flows here automatically. The `assertCoinType` helper
 * keeps strict typing while making the runtime lookup explicit.
 */
const COIN_TYPES = {
  btc: assertCoinType('btc'),
  ltc: assertCoinType('ltc'),
  xmr: assertCoinType('xmr'),
  wow: assertCoinType('wow'),
} as const;

function assertCoinType(id: 'btc' | 'ltc' | 'xmr' | 'wow'): number {
  const def = registry.mustGet(id);
  const mainnet = def.networks.mainnet;
  if (!mainnet) {
    throw new Error(
      `@smirk/core/hd: asset "${id}" must define a mainnet network with a BIP44 coin type`,
    );
  }
  return mainnet.bip44CoinType;
}

export interface GrinKeys {
  /** Private key (32 bytes) — ed25519 scalar. */
  privateKey: Uint8Array;
  /** Public key (32 bytes) — ed25519 point, used as slatepack address. */
  publicKey: Uint8Array;
}

export interface CryptonoteKeys {
  /** Private spend key (32 bytes) — for signing transactions. */
  privateSpendKey: Uint8Array;
  /** Private view key (32 bytes) — for scanning + LWS registration. */
  privateViewKey: Uint8Array;
  /** Public spend key (32 bytes) — half of the public address. */
  publicSpendKey: Uint8Array;
  /** Public view key (32 bytes) — half of the public address. */
  publicViewKey: Uint8Array;
}

/**
 * All per-asset keys derived from a single mnemonic. The shape varies
 * by chain family because the cryptographic primitives differ:
 *
 * - **UTXO** (BTC, LTC) — secp256k1: one (privateKey, publicKey) pair
 *   per chain.
 * - **Cryptonote** (XMR, WOW) — ed25519 with the dual-key model: a
 *   spend key and a view key, public AND private. See
 *   {@link CryptonoteKeys}.
 * - **Mimblewimble** (Grin) — schnorr-on-secp256k1zkp plus the
 *   slatepack-address ed25519 keypair. See {@link GrinKeys}.
 * - **Nostr** (NIP-06 identity): secp256k1 schnorr, one (privateKey,
 *   x-only publicKey) pair at account 0. Cached here so a session-cache
 *   restore (which drops the mnemonic + seed) can still sign nostr events
 *   and answer getPublicKey without re-deriving from the now-absent phrase.
 *   Version-independent: the same account-0 path in v1/v2/v3.
 *
 * Per-asset shapes deliberately don't share a base type — that would
 * paper over the asymmetry and force every consumer to narrow.
 */
export interface DerivedKeys {
  btc: { privateKey: Uint8Array; publicKey: Uint8Array; accountXpub?: string };
  ltc: { privateKey: Uint8Array; publicKey: Uint8Array; accountXpub?: string };
  xmr: CryptonoteKeys;
  wow: CryptonoteKeys;
  grin: GrinKeys;
  /** NIP-06 nostr identity keypair, account 0. `publicKey` is x-only (schnorr). */
  nostr: { privateKey: Uint8Array; publicKey: Uint8Array };
}

// ============================================================================
// Mnemonic
// ============================================================================

/** New 12-word BIP39 mnemonic (128 bits of entropy). */
export function generateMnemonicPhrase(): string {
  return generateMnemonic(wordlist, 128);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

/** BIP39 seed (PBKDF2-HMAC-SHA512, 64 bytes) from mnemonic + passphrase. */
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Uint8Array {
  return mnemonicToSeedSync(mnemonic, passphrase);
}

/**
 * Stable fingerprint for a wallet — `hex(SHA256(SHA256(bip39_seed)))`.
 *
 * Sent to the backend at wallet creation; checked at restore time so we
 * can confirm a recovery is for a Smirk-created wallet (and not, e.g.,
 * a vanilla BIP39 wallet whose user is trying to import into Smirk).
 *
 * 256-bit collision resistance ≈ 2^128 — brute force infeasible.
 */
export function computeSeedFingerprint(mnemonic: string, passphrase = ''): string {
  const seed = mnemonicToSeed(mnemonic, passphrase);
  const hash1 = sha256(seed);
  const hash2 = sha256(hash1);
  return Array.from(hash2)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// secp256k1 derivation (BTC, LTC, and the Cake-compatible XMR path)
// ============================================================================

/**
 * Derive `m/<purpose>'/coin'/0'/0/0` and return the leaf priv/pub key pair.
 *
 * `purpose` selects the BIP44/BIP84/BIP86 hardened first segment:
 * - `44` — BIP44 legacy path (used internally by XMR/WOW Cake-compatible
 *   derivation, where the leaf key is then reduced mod ℓ).
 * - `84` — BIP84 native-segwit path (used by BTC/LTC since 2026-05-11,
 *   replacing the earlier non-standard `BIP44 path + P2WPKH encoding`
 *   combination — see `docs/SEND_FLOW.md` § "BTC/LTC standardization to BIP84"
 *   for the migration record).
 */
function deriveSecp256k1Key(
  masterSeed: Uint8Array,
  coinType: number,
  purpose: 44 | 84,
): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const hdKey = HDKey.fromMasterSeed(masterSeed);
  const derived = hdKey.derive(`m/${purpose}'/${coinType}'/0'/0/0`);

  if (!derived.privateKey || !derived.publicKey) {
    throw new Error('Failed to derive key');
  }

  return {
    privateKey: derived.privateKey,
    publicKey: derived.publicKey,
  };
}

/** BTC/LTC standard P2WPKH derivation at `m/84'/coin'/0'/0/0`. */
function deriveBip84Key(
  masterSeed: Uint8Array,
  coinType: number,
): { privateKey: Uint8Array; publicKey: Uint8Array } {
  return deriveSecp256k1Key(masterSeed, coinType, 84);
}

/**
 * Neutered BIP84 ACCOUNT extended public key (`xpub`) at `m/84'/coin'/0'`.
 *
 * The account xpub is the enabler for the gap-limit fresh-address feature
 * (Lane 5, gated behind `ENABLE_BTCLTC_FRESH_ADDRS`): it lets the wallet
 * derive any receive (`/0/i`) or change (`/1/j`) PUBLIC key — and thus the
 * bech32 address — on a WARM session (session-cache restore, mnemonic +
 * seed absent) WITHOUT the recovery phrase. Signing still requires the
 * mnemonic (the wasm PSBT path), so this xpub is a view-only credential:
 * disclosure derives addresses, never a spend authority.
 *
 * Index 0 (`m/84'/coin'/0'/0/0`) remains the unchanged primary receive
 * address, so a wallet with the feature OFF behaves exactly as before.
 */
export function deriveBip84AccountXpub(masterSeed: Uint8Array, coinType: number): string {
  const account = HDKey.fromMasterSeed(masterSeed).derive(`m/84'/${coinType}'/0'`);
  // `publicExtendedKey` is the neutered (public-only) serialization — no
  // private material is encoded, which is what makes it warm-session safe.
  return account.publicExtendedKey;
}

/**
 * Derive the BIP84 key at `.../change/index` under a given account.
 *
 * `source` is EITHER a master seed (with `coinType` supplied) — in which
 * case the full `m/84'/coin'/0'/change/index` path is walked and BOTH the
 * private and public key come back — OR an account-level xpub string (the
 * `deriveBip84AccountXpub` output), in which case only the PUBLIC key is
 * available (no private material can exist behind a neutered xpub).
 *
 * `change` is 0 (external / receive chain) or 1 (internal / change chain)
 * per BIP44; `index` is the leaf address index. `(change, index) = (0, 0)`
 * reproduces the wallet's primary receive key byte-for-byte.
 */
export function deriveBip84KeyAt(
  source: Uint8Array | string,
  change: 0 | 1,
  index: number,
  coinType?: number,
): { publicKey: Uint8Array; privateKey?: Uint8Array } {
  if (change !== 0 && change !== 1) {
    throw new Error(`deriveBip84KeyAt: change must be 0 or 1, got ${change}`);
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`deriveBip84KeyAt: index must be a non-negative integer, got ${index}`);
  }

  let node: HDKey;
  if (typeof source === 'string') {
    // Account-level xpub → non-hardened change/index descent (pubkey-only).
    node = HDKey.fromExtendedKey(source).deriveChild(change).deriveChild(index);
  } else {
    if (coinType === undefined) {
      throw new Error('deriveBip84KeyAt: coinType is required when deriving from a seed');
    }
    node = HDKey.fromMasterSeed(source).derive(`m/84'/${coinType}'/0'/${change}/${index}`);
  }

  if (!node.publicKey) {
    throw new Error('deriveBip84KeyAt: derivation produced no public key');
  }
  return node.privateKey
    ? { publicKey: node.publicKey, privateKey: node.privateKey }
    : { publicKey: node.publicKey };
}

/**
 * Pre-v0.3 BTC/LTC derivation at `m/44'/coin'/0'/0/0` (used with P2WPKH
 * encoding — the Smirk-specific non-standard combination). Kept so the
 * `seed-to-keys` recovery script can show users their legacy addresses
 * for migration purposes. Not used by the current `deriveAllKeys` v3
 * code path — use `deriveBip84Key` for new derivations.
 */
export function deriveLegacyBtcLtcKey(
  masterSeed: Uint8Array,
  coinType: number,
): { privateKey: Uint8Array; publicKey: Uint8Array } {
  return deriveSecp256k1Key(masterSeed, coinType, 44);
}

/** Internal alias used by Cake-compatible XMR/WOW derivation. */
function deriveBip44Key(
  masterSeed: Uint8Array,
  coinType: number,
): { privateKey: Uint8Array; publicKey: Uint8Array } {
  return deriveSecp256k1Key(masterSeed, coinType, 44);
}

// ============================================================================
// ed25519 scalar helpers (Monero/Wownero)
// ============================================================================

/** Read 32 little-endian bytes as a BigInt and reduce mod l. */
function bytesToScalar(bytes: Uint8Array): bigint {
  let scalar = 0n;
  for (let i = 0; i < 32; i++) {
    scalar += BigInt(bytes[i]!) << BigInt(8 * i);
  }
  // ed25519 curve order l = 2^252 + 27742317777372353535851937790883648493.
  const l = 2n ** 252n + 27742317777372353535851937790883648493n;
  return scalar % l;
}

/** Write a BigInt scalar as 32 little-endian bytes. */
function scalarToBytes(scalar: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let remaining = scalar;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

// ============================================================================
// v1 Cryptonote derivation (legacy custom SHA256)
// ============================================================================

/**
 * v1 Monero/Wownero key derivation — SHA256 of master seed + a per-coin
 * domain separator. Kept for sweep/migration of pre-v3 wallets.
 *
 * The flow:
 *   1. seed' = SHA256(master_seed || "smirk:{coin}:v1")
 *   2. private_spend = scalar_reduce(seed')
 *   3. private_view  = scalar_reduce(SHA256(private_spend))   (Monero Hs())
 *   4. public_*      = private_* · G                           (ed25519)
 *
 * Storing the *reduced* spend key (rather than the raw hash bytes) is
 * load-bearing: the public key is derived from the reduced scalar, so
 * if we stored raw bytes we'd save a value that doesn't match the
 * public key in the address.
 */
function deriveCryptonoteKeys(masterSeed: Uint8Array, coinId: string): CryptonoteKeys {
  const domainSeparator = new TextEncoder().encode(`smirk:${coinId}:v1`);
  const combined = new Uint8Array(masterSeed.length + domainSeparator.length);
  combined.set(masterSeed);
  combined.set(domainSeparator, masterSeed.length);

  const spendKeySeed = sha256(combined);
  const spendKeyScalar = bytesToScalar(spendKeySeed);
  const privateSpendKey = scalarToBytes(spendKeyScalar);

  const viewKeySeed = sha256(privateSpendKey);
  const viewKeyScalar = bytesToScalar(viewKeySeed);
  const privateViewKey = scalarToBytes(viewKeyScalar);

  const publicSpendKey = ed25519.ExtendedPoint.BASE.multiply(spendKeyScalar).toRawBytes();
  const publicViewKey = ed25519.ExtendedPoint.BASE.multiply(viewKeyScalar).toRawBytes();

  return { privateSpendKey, privateViewKey, publicSpendKey, publicViewKey };
}

// ============================================================================
// v2 SLIP-10 ed25519 derivation (BUGGY — kept for migration)
// ============================================================================

/**
 * SLIP-10 ed25519 hierarchical key derivation.
 *
 * Ref: https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 *
 * ed25519 SLIP-10 only supports hardened derivation — the path
 * components passed in are raw indices (0, 44, 128) and we OR in the
 * hardened bit ourselves.
 */
function slip10DeriveEd25519(seed: Uint8Array, path: number[]): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32, 64);

  for (const index of path) {
    const hardenedIndex = (index | 0x80000000) >>> 0;
    const data = new Uint8Array(37);
    data[0] = 0x00;
    data.set(key, 1);
    data[33] = (hardenedIndex >>> 24) & 0xff;
    data[34] = (hardenedIndex >>> 16) & 0xff;
    data[35] = (hardenedIndex >>> 8) & 0xff;
    data[36] = hardenedIndex & 0xff;

    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32, 64);
  }

  return key;
}

/**
 * v2 Monero/Wownero derivation — buggy SLIP-10 path `m/44'/coin'/0'`.
 *
 * Kept because v2 wallets exist on disk; the migration code reads them,
 * derives v3 keys, and sweeps the v2 funds. Don't use for new wallets.
 */
function deriveBip44MoneroKeys(masterSeed: Uint8Array, coinType: number): CryptonoteKeys {
  const rawKey = slip10DeriveEd25519(masterSeed, [44, coinType, 0]);

  const spendKeyScalar = bytesToScalar(rawKey);
  const privateSpendKey = scalarToBytes(spendKeyScalar);

  // Monero's Hs() — Keccak-256 reduced mod l.
  const viewKeySeed = keccak_256(privateSpendKey);
  const viewKeyScalar = bytesToScalar(viewKeySeed);
  const privateViewKey = scalarToBytes(viewKeyScalar);

  const publicSpendKey = ed25519.ExtendedPoint.BASE.multiply(spendKeyScalar).toRawBytes();
  const publicViewKey = ed25519.ExtendedPoint.BASE.multiply(viewKeyScalar).toRawBytes();

  return { privateSpendKey, privateViewKey, publicSpendKey, publicViewKey };
}

// ============================================================================
// v3 BIP32-secp256k1 → mod l (current, Cake Wallet compatible)
// ============================================================================

/**
 * v3 Monero/Wownero derivation — BIP32 secp256k1 at
 * `m/44'/coin'/0'/0/0`, then reduce the leaf private key mod l.
 *
 * The non-hardened tail (`/0/0`) is the choice that matches Cake
 * Wallet (cw_monero/lib/bip39_seed.dart). Other wallets stop at the
 * 3-level path; the `_0/0` matters for cross-wallet restore.
 */
function deriveBip32MoneroKeys(masterSeed: Uint8Array, coinType: number): CryptonoteKeys {
  const bip32Key = deriveBip44Key(masterSeed, coinType);

  const spendKeyScalar = bytesToScalar(bip32Key.privateKey);
  const privateSpendKey = scalarToBytes(spendKeyScalar);

  const viewKeySeed = keccak_256(privateSpendKey);
  const viewKeyScalar = bytesToScalar(viewKeySeed);
  const privateViewKey = scalarToBytes(viewKeyScalar);

  const publicSpendKey = ed25519.ExtendedPoint.BASE.multiply(spendKeyScalar).toRawBytes();
  const publicViewKey = ed25519.ExtendedPoint.BASE.multiply(viewKeyScalar).toRawBytes();

  return { privateSpendKey, privateViewKey, publicSpendKey, publicViewKey };
}

// ============================================================================
// Grin v1 (legacy — for new flows use @smirk/wasm `grin.deriveExtendedKey`)
// ============================================================================

/**
 * Legacy Grin slatepack ed25519 keys — `SHA256(master || "smirk:grin:v1")`.
 *
 * Preserved verbatim so existing Smirk wallets keep producing the
 * same slatepack address they did before. New Grin wallet flows
 * (sending, slate construction, payment proofs) should go through
 * `@smirk/wasm`'s grin namespace, which does the canonical
 * grin-wallet/Grim-compatible derivation (HMAC-SHA512 with key
 * `"IamVoldemort"` over raw BIP39 entropy).
 */
function deriveGrinKey(masterSeed: Uint8Array): GrinKeys {
  const domainSeparator = new TextEncoder().encode('smirk:grin:v1');
  const combined = new Uint8Array(masterSeed.length + domainSeparator.length);
  combined.set(masterSeed);
  combined.set(domainSeparator, masterSeed.length);

  const keySeed = sha256(combined);
  const keyScalar = bytesToScalar(keySeed);
  const privateKey = scalarToBytes(keyScalar);

  const publicKey = ed25519.ExtendedPoint.BASE.multiply(keyScalar).toRawBytes();

  return { privateKey, publicKey };
}

// ============================================================================
// Nostr identity (NIP-06): version-independent secp256k1 schnorr
// ============================================================================

/** SLIP-0044 coin type for Nostr keys (NIP-06). */
const NOSTR_COIN_TYPE = 1237;

/**
 * Canonical low-level Nostr key derivation (NIP-06): BIP32 secp256k1 at
 * `m/44'/1237'/<account>'/0/0`, returning the raw private key plus its
 * x-only (schnorr) public key. This is the SINGLE source of truth shared
 * by {@link deriveAllKeys} here and `nostr/identity.ts`'s
 * `deriveNostrIdentity`, so the two can never drift.
 *
 * It lives in `hd.ts` (not `identity.ts`) to avoid an import cycle:
 * `identity.ts` already imports `mnemonicToSeed` from this module, so the
 * primitive belongs here and `identity.ts` builds the `NostrIdentity`
 * (npub / pubkeyHex) on top of it.
 *
 * The nostr identity path is version-independent; all three derivation
 * generations use this same account-0 derivation.
 */
export function deriveNostrKeyFromSeed(
  masterSeed: Uint8Array,
  account = 0,
): { privateKey: Uint8Array; publicKey: Uint8Array } {
  if (!Number.isInteger(account) || account < 0) {
    throw new Error(`invalid nostr account index: ${account}`);
  }
  const node = HDKey.fromMasterSeed(masterSeed).derive(
    `m/44'/${NOSTR_COIN_TYPE}'/${account}'/0/0`,
  );
  if (!node.privateKey) throw new Error('failed to derive nostr key');
  return { privateKey: node.privateKey, publicKey: schnorr.getPublicKey(node.privateKey) };
}

// ============================================================================
// Top-level derivation
// ============================================================================

/** Derivation generation — keep all so v1/v2 wallets can be swept. */
export type DerivationVersion = 1 | 2 | 3;

/**
 * Derive the full per-asset keyset from a mnemonic.
 *
 * @param mnemonic   BIP39 12-word phrase
 * @param passphrase Optional BIP39 passphrase (defaults to empty)
 * @param version    1 = legacy custom, 2 = buggy SLIP-10, 3 = current
 */
export function deriveAllKeys(
  mnemonic: string,
  passphrase = '',
  version: DerivationVersion = 1,
): DerivedKeys {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }

  const masterSeed = mnemonicToSeed(mnemonic, passphrase);

  if (version === 3) {
    // v3 BTC/LTC uses BIP84 (m/84') — the industry-standard P2WPKH path.
    // Switched 2026-05-11; pre-v0.3 wallets used m/44' here (non-standard).
    // Legacy `deriveLegacyBtcLtcKey` remains for the seed-to-keys recovery
    // script so users on the old path can locate their funds.
    return {
      btc: {
        ...deriveBip84Key(masterSeed, COIN_TYPES.btc),
        accountXpub: deriveBip84AccountXpub(masterSeed, COIN_TYPES.btc),
      },
      ltc: {
        ...deriveBip84Key(masterSeed, COIN_TYPES.ltc),
        accountXpub: deriveBip84AccountXpub(masterSeed, COIN_TYPES.ltc),
      },
      xmr: deriveBip32MoneroKeys(masterSeed, COIN_TYPES.xmr),
      wow: deriveBip32MoneroKeys(masterSeed, COIN_TYPES.wow),
      grin: deriveGrinKey(masterSeed),
      nostr: deriveNostrKeyFromSeed(masterSeed, 0),
    };
  }

  if (version === 2) {
    // v2 BTC/LTC matches the legacy pre-v0.3 path (BIP44 + P2WPKH
    // encoding). Kept for sweep/migration of existing alpha wallets.
    return {
      btc: deriveLegacyBtcLtcKey(masterSeed, COIN_TYPES.btc),
      ltc: deriveLegacyBtcLtcKey(masterSeed, COIN_TYPES.ltc),
      xmr: deriveBip44MoneroKeys(masterSeed, COIN_TYPES.xmr),
      wow: deriveBip44MoneroKeys(masterSeed, COIN_TYPES.wow),
      grin: deriveGrinKey(masterSeed),
      nostr: deriveNostrKeyFromSeed(masterSeed, 0),
    };
  }

  return {
    btc: deriveLegacyBtcLtcKey(masterSeed, COIN_TYPES.btc),
    ltc: deriveLegacyBtcLtcKey(masterSeed, COIN_TYPES.ltc),
    xmr: deriveCryptonoteKeys(masterSeed, 'xmr'),
    wow: deriveCryptonoteKeys(masterSeed, 'wow'),
    grin: deriveGrinKey(masterSeed),
    nostr: deriveNostrKeyFromSeed(masterSeed, 0),
  };
}

/** Human-readable description of each chain's path, by version. */
export function getDerivationInfo(version: DerivationVersion = 3): Record<string, string> {
  if (version === 3) {
    return {
      btc: "m/84'/0'/0'/0/0 (BIP84 native-segwit, standard P2WPKH)",
      ltc: "m/84'/2'/0'/0/0 (BIP84 native-segwit, standard P2WPKH)",
      xmr: "m/44'/128'/0'/0/0 (BIP32 secp256k1, Cake Wallet compatible)",
      wow: "m/44'/2086'/0'/0/0 (BIP32 secp256k1)",
      grin: 'HMAC-SHA512(IamVoldemort, raw_entropy) → addressKey(0) (grin-wallet/Grim compatible)',
    };
  }
  if (version === 2) {
    return {
      btc: "m/44'/0'/0'/0/0 (BIP44 standard)",
      ltc: "m/44'/2'/0'/0/0 (BIP44 standard)",
      xmr: "m/44'/128'/0' (SLIP-10 ed25519, buggy 3-level path)",
      wow: "m/44'/2086'/0' (SLIP-10 ed25519, buggy 3-level path)",
      grin: 'HMAC-SHA512(IamVoldemort, PBKDF2(mnemonic)) → addressKey(0) (MWC-style, legacy)',
    };
  }
  return {
    btc: "m/44'/0'/0'/0/0 (BIP44 standard)",
    ltc: "m/44'/2'/0'/0/0 (BIP44 standard)",
    xmr: 'SHA256(master || "smirk:xmr:v1") — legacy custom',
    wow: 'SHA256(master || "smirk:wow:v1") — legacy custom',
    grin: 'SHA256(master || "smirk:grin:v1") — custom derivation',
  };
}

// ============================================================================
// Mnemonic UI helpers
// ============================================================================

export function mnemonicToWords(mnemonic: string): string[] {
  return mnemonic.trim().split(/\s+/);
}

export function wordsToMnemonic(words: string[]): string {
  return words.join(' ');
}

/** Random distinct word indices for the seed-verification UI. */
export function getVerificationIndices(wordCount: number, verifyCount = 3): number[] {
  const indices: number[] = [];
  while (indices.length < verifyCount) {
    const idx = Math.floor(Math.random() * wordCount);
    if (!indices.includes(idx)) {
      indices.push(idx);
    }
  }
  return indices.sort((a, b) => a - b);
}
