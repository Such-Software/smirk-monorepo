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

const NETWORKS = {
  btc: { bech32: 'bc', pubkeyHash: 0x00, scriptHash: 0x05 },
  ltc: { bech32: 'ltc', pubkeyHash: 0x30, scriptHash: 0x32 },
  xmr: { addressPrefix: 18, integratedPrefix: 19, subaddressPrefix: 42 },
  wow: { addressPrefix: 4146, integratedPrefix: 4147, subaddressPrefix: 6810 },
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

