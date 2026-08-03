/**
 * Address derivation and validation for all supported chains.
 *
 * - **BTC/LTC** — P2WPKH (bech32, `bc1q…` / `ltc1q…`).
 * - **XMR/WOW** — Cryptonote standard address (prefix + spend + view +
 *   4-byte Keccak checksum, encoded with Monero base58).
 * - **Grin** — slatepack address (ed25519 pubkey, bech32-encoded with
 *   the `grin` HRP). Not an on-chain address; used for slate
 *   encryption and Tor-onion derivation.
 *
 * Long-term these will move to Rust (the `crates/btc-ext`,
 * `crates/monero-oxide/wallet/address`, and `crates/grin-ext` crates
 * already implement them). For now, this JS layer is the canonical
 * surface so `@smirk/core` is import-time WASM-free.
 */

import { bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { keccak_256 } from '@noble/hashes/sha3';
import { ed25519 } from '@noble/curves/ed25519';
import { deriveBip84KeyAt } from './hd';

const NETWORKS = {
  btc: { bech32: 'bc', pubkeyHash: 0x00, scriptHash: 0x05 },
  ltc: { bech32: 'ltc', pubkeyHash: 0x30, scriptHash: 0x32 },
  // Cryptonote network prefixes are encoded as varints in the address
  // payload. Values from upstream `cryptonote_config.h`:
  //   XMR mainnet: address=18 (0x12), integrated=19 (0x13), subaddress=42 (0x2A)
  //   WOW mainnet: address=4146 (0x1032), integrated=4148 (0x1034),
  //                subaddress=12208 (0x2FB0)
  // The WOW values are confirmed against a real Stack Wallet subaddress
  // (`WW3pXrjga...CCM5ge`), whose varint prefix decodes to 12208.
  xmr: { addressPrefix: 18, integratedPrefix: 19, subaddressPrefix: 42 },
  wow: { addressPrefix: 4146, integratedPrefix: 4148, subaddressPrefix: 12208 },
} as const;

// ============================================================================
// BTC / LTC P2WPKH
// ============================================================================

/** Bitcoin P2WPKH (bech32) address from a compressed secp256k1 pubkey. */
export function btcAddress(publicKey: Uint8Array): string {
  return generateBech32Address(publicKey, NETWORKS.btc.bech32);
}

/** Litecoin P2WPKH (bech32) address from a compressed secp256k1 pubkey. */
export function ltcAddress(publicKey: Uint8Array): string {
  return generateBech32Address(publicKey, NETWORKS.ltc.bech32);
}

/**
 * Bitcoin P2WPKH address at a specific BIP84 receive/change index, from the
 * account xpub (`m/84'/0'/0'`). `change` is 0 (receive) or 1 (change);
 * `index` is the leaf. `(0, 0)` reproduces {@link btcAddress} for the same
 * wallet. Feeds the gap-limit fresh-address book (Lane 5, gated behind
 * `ENABLE_BTCLTC_FRESH_ADDRS`). Reuses the same audited bech32 encoder as
 * the primary address, so a fresh address is byte-identical to what an
 * external BIP84 wallet (Sparrow, Electrum) derives from the same seed.
 */
export function btcAddressAt(accountXpub: string, change: 0 | 1, index: number): string {
  return generateBech32Address(
    deriveBip84KeyAt(accountXpub, change, index).publicKey,
    NETWORKS.btc.bech32,
  );
}

/** Litecoin P2WPKH address at a specific BIP84 receive/change index. See {@link btcAddressAt}. */
export function ltcAddressAt(accountXpub: string, change: 0 | 1, index: number): string {
  return generateBech32Address(
    deriveBip84KeyAt(accountXpub, change, index).publicKey,
    NETWORKS.ltc.bech32,
  );
}

/** Witness-version-0 bech32 P2WPKH: `hrp1q…` over HASH160(pubkey). */
function generateBech32Address(publicKey: Uint8Array, hrp: string): string {
  const hash160 = ripemd160(sha256(publicKey));

  const witnessVersion = 0;
  const words = bech32.toWords(hash160);

  const fullWords = new Uint8Array(words.length + 1);
  fullWords[0] = witnessVersion;
  fullWords.set(words, 1);

  return bech32.encode(hrp, fullWords);
}

// ============================================================================
// XMR / WOW Cryptonote
// ============================================================================

/** Monero standard address from public spend + view keys. */
export function xmrAddress(publicSpendKey: Uint8Array, publicViewKey: Uint8Array): string {
  return generateCryptonoteAddress(publicSpendKey, publicViewKey, NETWORKS.xmr.addressPrefix);
}

/** Wownero standard address from public spend + view keys. */
export function wowAddress(publicSpendKey: Uint8Array, publicViewKey: Uint8Array): string {
  return generateCryptonoteAddress(publicSpendKey, publicViewKey, NETWORKS.wow.addressPrefix);
}

// ----------------------------------------------------------------------------
// XMR / WOW subaddresses (per-payment receive privacy)
// ----------------------------------------------------------------------------
//
// A subaddress is an unlinkable receive address derived from the SAME account
// keys. Handing out a fresh one per payment stops on-chain clustering of a
// user's incoming funds. The LWS (monero-lws / wownero-lws, built with
// `--max-subaddresses > 0`) attributes funds to a provisioned subaddress range
// using only the private view key it already holds.

/** ed25519 group order l = 2^252 + 27742317777372353535851937790883648493. */
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

/** Read little-endian `bytes` as a BigInt reduced mod l (a Monero scalar). */
function leBytesToScalarModL(bytes: Uint8Array): bigint {
  let s = 0n;
  for (let i = 0; i < bytes.length; i++) s += BigInt(bytes[i]!) << BigInt(8 * i);
  return s % ED25519_L;
}

/** 32-bit unsigned little-endian encoding (matches Rust `u32::to_le_bytes`). */
function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  b[2] = (n >>> 16) & 0xff;
  b[3] = (n >>> 24) & 0xff;
  return b;
}

/** Domain separator for subaddress derivation: the ASCII bytes `SubAddr\0`. */
const SUBADDR_DOMAIN = new Uint8Array([0x53, 0x75, 0x62, 0x41, 0x64, 0x64, 0x72, 0x00]);

/**
 * Derive a Cryptonote subaddress for `(major, minor)` from the account's PUBLIC
 * spend key `B` and PRIVATE view key `a` (32-byte little-endian scalar).
 *
 * Mirrors Monero's `get_subaddress` / monero-oxide `ViewPair::subaddress_keys`
 * exactly:
 *   m = Hs("SubAddr\0" || a || major_LE || minor_LE)   // Hs = keccak256 mod l
 *   D = B + m·G
 *   C = a·D
 *   address = base58( subaddressPrefix || D || C || keccak(prefix||D||C)[:4] )
 *
 * `(0, 0)` is the PRIMARY address, not a subaddress; callers must pass a
 * non-zero index. Passing `(0, 0)` throws so a caller cannot silently hand out
 * the primary address (which the LWS scans separately) as if it were fresh.
 */
function cryptonoteSubaddress(
  publicSpendKey: Uint8Array,
  privateViewKey: Uint8Array,
  major: number,
  minor: number,
  subaddressPrefix: number,
): string {
  if (major === 0 && minor === 0) {
    throw new Error('(0,0) is the primary address, not a subaddress; use minor >= 1');
  }

  // m = Hs("SubAddr\0" || a || major_LE || minor_LE)
  const input = new Uint8Array(8 + 32 + 4 + 4);
  input.set(SUBADDR_DOMAIN, 0);
  input.set(privateViewKey, 8);
  input.set(u32le(major), 40);
  input.set(u32le(minor), 44);
  const m = leBytesToScalarModL(keccak_256(input));

  // D = B + m·G  (subaddress public spend key)
  const B = ed25519.ExtendedPoint.fromHex(publicSpendKey);
  const D = B.add(ed25519.ExtendedPoint.BASE.multiply(m));

  // C = a·D  (subaddress public view key)
  const a = leBytesToScalarModL(privateViewKey);
  const C = D.multiply(a);

  return generateCryptonoteAddress(D.toRawBytes(), C.toRawBytes(), subaddressPrefix);
}

/** Monero (XMR) subaddress for `(major, minor)`. For account 0, `minor >= 1`. */
export function xmrSubaddress(
  publicSpendKey: Uint8Array,
  privateViewKey: Uint8Array,
  major: number,
  minor: number,
): string {
  return cryptonoteSubaddress(
    publicSpendKey,
    privateViewKey,
    major,
    minor,
    NETWORKS.xmr.subaddressPrefix,
  );
}

/** Wownero (WOW) subaddress for `(major, minor)`. For account 0, `minor >= 1`. */
export function wowSubaddress(
  publicSpendKey: Uint8Array,
  privateViewKey: Uint8Array,
  major: number,
  minor: number,
): string {
  return cryptonoteSubaddress(
    publicSpendKey,
    privateViewKey,
    major,
    minor,
    NETWORKS.wow.subaddressPrefix,
  );
}

/**
 * Cryptonote address: `prefix || spend(32) || view(32) || keccak(prefix || spend || view)[:4]`,
 * encoded with Monero's variant of base58 (8-byte blocks → 11-char encoded blocks).
 */
function generateCryptonoteAddress(
  publicSpendKey: Uint8Array,
  publicViewKey: Uint8Array,
  prefix: number,
): string {
  const prefixBytes = encodeVarint(prefix);
  const data = new Uint8Array(prefixBytes.length + 32 + 32);
  data.set(prefixBytes, 0);
  data.set(publicSpendKey, prefixBytes.length);
  data.set(publicViewKey, prefixBytes.length + 32);

  const hash = keccak_256(data);
  const checksum = hash.slice(0, 4);

  const fullData = new Uint8Array(data.length + 4);
  fullData.set(data, 0);
  fullData.set(checksum, data.length);

  return cnBase58Encode(fullData);
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>= 7;
  }
  bytes.push(value);
  return new Uint8Array(bytes);
}

/** Monero base58 alphabet (NOT Bitcoin's). */
const CN_BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Monero's base58: 8-byte blocks encoded as 11-char strings. */
function cnBase58Encode(data: Uint8Array): string {
  const fullBlockSize = 8;
  const fullEncodedBlockSize = 11;

  let result = '';
  for (let i = 0; i < data.length; i += fullBlockSize) {
    const blockSize = Math.min(fullBlockSize, data.length - i);
    const block = data.slice(i, i + blockSize);

    let num = 0n;
    for (let j = 0; j < block.length; j++) {
      num = num * 256n + BigInt(block[j]!);
    }

    let encoded = '';
    const encodedSize =
      blockSize === fullBlockSize ? fullEncodedBlockSize : getEncodedBlockSize(blockSize);

    for (let j = 0; j < encodedSize; j++) {
      const remainder = num % 58n;
      num = num / 58n;
      encoded = CN_BASE58_ALPHABET[Number(remainder)] + encoded;
    }

    result += encoded;
  }

  return result;
}

function getEncodedBlockSize(blockSize: number): number {
  // Mapping from raw block size (0–8) to encoded char count.
  const sizes = [0, 2, 3, 5, 6, 7, 9, 10, 11];
  return sizes[blockSize]!;
}

// ============================================================================
// Grin slatepack
// ============================================================================

/**
 * Grin slatepack address from a 32-byte ed25519 public key.
 * Format: `grin1…` (bech32 — Grin uses standard bech32, NOT bech32m).
 *
 * Slatepack addresses are not on-chain (Mimblewimble has no addresses);
 * they're used for slate encryption during interactive tx building and
 * for deriving Tor onion service addresses.
 */
export function grinSlatpackAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error('Grin slatepack address requires a 32-byte ed25519 public key');
  }
  const words = bech32.toWords(publicKey);
  // Limit 1023 (vs default 90) to allow longer addresses.
  return bech32.encode('grin', words, 1023);
}

// ============================================================================
// Validation
// ============================================================================

/** True iff `address` parses as a `bc1…` bech32 address. */
export function isValidBtcAddress(address: string): boolean {
  try {
    if (!address.includes('1')) return false;
    const decoded = bech32.decode(address as `${string}1${string}`);
    return decoded.prefix === 'bc' && decoded.words.length > 0;
  } catch {
    return false;
  }
}

/** True iff `address` parses as a `ltc1…` bech32 address. */
export function isValidLtcAddress(address: string): boolean {
  try {
    if (!address.includes('1')) return false;
    const decoded = bech32.decode(address as `${string}1${string}`);
    return decoded.prefix === 'ltc' && decoded.words.length > 0;
  } catch {
    return false;
  }
}

/**
 * True iff `address` decodes as a valid Monero (XMR) address.
 *
 * Verifies the Monero base58 → byte stream → varint prefix matches
 * mainnet (standard, integrated, or subaddress) and the trailing
 * 4-byte Keccak-256 checksum over the rest of the payload.
 */
export function isValidXmrAddress(address: string): boolean {
  return isValidCryptonoteAddress(address, [
    NETWORKS.xmr.addressPrefix,
    NETWORKS.xmr.integratedPrefix,
    NETWORKS.xmr.subaddressPrefix,
  ]);
}

/**
 * True iff `address` decodes as a valid Wownero (WOW) address.
 * Same construction as Monero with different prefixes.
 */
export function isValidWowAddress(address: string): boolean {
  return isValidCryptonoteAddress(address, [
    NETWORKS.wow.addressPrefix,
    NETWORKS.wow.integratedPrefix,
    NETWORKS.wow.subaddressPrefix,
  ]);
}

/**
 * True iff `address` is a valid `grin1…` slatepack address — bech32
 * (NOT bech32m), 32-byte ed25519 public-key payload.
 */
export function isValidGrinSlatepackAddress(address: string): boolean {
  try {
    if (!address.startsWith('grin1') || !address.includes('1')) return false;
    const decoded = bech32.decode(address as `${string}1${string}`, 1023);
    if (decoded.prefix !== 'grin') return false;
    const bytes = bech32.fromWords(decoded.words);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

/**
 * Decode + validate a Cryptonote-style address against an allowed set
 * of prefix integers. Used by the XMR and WOW validators above.
 *
 * Steps: base58 decode → split into payload + 4-byte checksum →
 * verify checksum is `keccak_256(payload)[:4]` → decode the leading
 * varint and check it's in `allowedPrefixes`.
 */
function isValidCryptonoteAddress(address: string, allowedPrefixes: number[]): boolean {
  try {
    const data = cnBase58Decode(address);
    if (data === null) return false;
    if (data.length < 4) return false;

    const payload = data.slice(0, data.length - 4);
    const checksum = data.slice(data.length - 4);

    const expected = keccak_256(payload).slice(0, 4);
    for (let i = 0; i < 4; i++) {
      if (expected[i] !== checksum[i]) return false;
    }

    const prefix = decodeVarint(payload);
    if (prefix === null) return false;
    return allowedPrefixes.includes(prefix.value);
  } catch {
    return false;
  }
}

/** Decode the leading varint from `bytes`. Returns `null` on malformed input. */
function decodeVarint(bytes: Uint8Array): { value: number; bytesRead: number } | null {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (shift >= 28 && (byte & 0x7f) > 0x0f) return null; // overflow guard
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, bytesRead: i + 1 };
    shift += 7;
    if (shift > 28) return null;
  }
  return null;
}

/**
 * Inverse of `cnBase58Encode`. Returns `null` if the string contains
 * characters outside Monero's base58 alphabet or has an invalid length
 * for any 11-char block.
 */
function cnBase58Decode(s: string): Uint8Array | null {
  const fullEncodedBlockSize = 11;
  // Mapping from encoded block size (chars) → decoded byte count.
  // Inverse of `getEncodedBlockSize`: positions where lookup is valid
  // are 2,3,5,6,7,9,10,11; other lengths within a partial block are invalid.
  const decodedSizeFor: Record<number, number> = {
    0: 0, 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 9: 6, 10: 7, 11: 8,
  };

  const result: number[] = [];
  for (let i = 0; i < s.length; i += fullEncodedBlockSize) {
    const blockChars = s.slice(i, i + fullEncodedBlockSize);
    const decodedSize = decodedSizeFor[blockChars.length];
    if (decodedSize === undefined) return null;

    let num = 0n;
    for (const ch of blockChars) {
      const v = CN_BASE58_ALPHABET.indexOf(ch);
      if (v < 0) return null;
      num = num * 58n + BigInt(v);
    }

    // Reject overflow: each decoded block must fit in `decodedSize` bytes.
    if (num >= 1n << BigInt(decodedSize * 8)) return null;

    const block: number[] = [];
    for (let j = 0; j < decodedSize; j++) {
      block.unshift(Number(num & 0xffn));
      num >>= 8n;
    }
    for (const b of block) result.push(b);
  }

  return new Uint8Array(result);
}

