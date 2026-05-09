/**
 * Cryptographic utilities for the Smirk wallet shell.
 *
 * Two distinct crypto surfaces live here:
 *
 * 1. **Local seed/private-key storage** — PBKDF2(password) → AES-equivalent
 *    encryption (we use XChaCha20-Poly1305 from @noble/ciphers, but the
 *    KDF is canonical PBKDF2-SHA256 via WebCrypto). Salts are 16 bytes,
 *    iterations default to OWASP 2023's 600k.
 *
 * 2. **Tip envelope encryption** — secp256k1 ECDH between an ephemeral
 *    sender keypair and the recipient's BTC public key, hashed to 32
 *    bytes via SHA-256, used as the symmetric key for the tip's actual
 *    secret material.
 *
 * Plus Bitcoin-style message signing (BIP-137 compact signatures), used
 * for `extensionRegister` proof-of-key-control during wallet bootstrap.
 *
 * Chain-specific transaction crypto lives in `@smirk/wasm` (Rust). This
 * module is pure WebCrypto + audited @noble libraries — no network, no
 * I/O, safe to call from any context.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from '@noble/hashes/utils';

export { randomBytes };

// ============================================================================
// secp256k1 helpers
// ============================================================================

export function generatePrivateKey(): Uint8Array {
  return secp256k1.utils.randomPrivateKey();
}

export function getPublicKey(privateKey: Uint8Array, compressed = true): Uint8Array {
  return secp256k1.getPublicKey(privateKey, compressed);
}

/**
 * ECDH → SHA-256, producing a uniform 32-byte symmetric key. Used for
 * encrypted tip payloads. The shared point is hashed (rather than used
 * raw) so the resulting key has no algebraic structure tied to the
 * underlying curve point.
 */
export function deriveSharedSecret(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  const sharedPoint = secp256k1.getSharedSecret(privateKey, publicKey);
  return sha256(sharedPoint);
}

// ============================================================================
// Symmetric encryption (XChaCha20-Poly1305)
// ============================================================================

/**
 * Encrypt with a 32-byte key.
 *
 * Output format: `nonce(24) || ciphertext || tag(16)` — the nonce is
 * prepended so callers don't need to track it separately. The Poly1305
 * tag is appended automatically by the AEAD construction.
 */
export function encrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(data);

  const result = new Uint8Array(nonce.length + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, nonce.length);
  return result;
}

export function decrypt(encryptedData: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = encryptedData.slice(0, 24);
  const ciphertext = encryptedData.slice(24);

  const cipher = xchacha20poly1305(key, nonce);
  return cipher.decrypt(ciphertext);
}

// ============================================================================
// Password-based key derivation
// ============================================================================

/** OWASP 2023 recommendation for SHA-256 PBKDF2. New wallets use this. */
export const PBKDF2_ITERATIONS = 600_000;

/** Legacy iteration count for wallets created before the upgrade. */
export const PBKDF2_ITERATIONS_LEGACY = 100_000;

/**
 * Derive a 32-byte symmetric key from a password via PBKDF2-SHA256.
 *
 * Uses WebCrypto (`crypto.subtle`) so the iterations run in native code,
 * not in the JS engine. Available in browsers, service workers, Deno,
 * and Node 18+. Capacitor's WKWebView and Android WebView both expose
 * WebCrypto, so mobile is fine.
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const keyBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    passwordKey,
    256,
  );

  return new Uint8Array(keyBits);
}

export async function encryptPrivateKey(
  privateKey: Uint8Array,
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<{ encrypted: string; salt: string }> {
  const salt = randomBytes(16);
  const key = await deriveKeyFromPassword(password, salt, iterations);
  const encrypted = encrypt(privateKey, key);

  return {
    encrypted: bytesToHex(encrypted),
    salt: bytesToHex(salt),
  };
}

export async function decryptPrivateKey(
  encryptedHex: string,
  saltHex: string,
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  const encrypted = hexToBytes(encryptedHex);
  const salt = hexToBytes(saltHex);
  const key = await deriveKeyFromPassword(password, salt, iterations);

  return decrypt(encrypted, key);
}

// ============================================================================
// Tip envelopes (encrypted-to-recipient and public)
// ============================================================================

/**
 * Encrypt a tip private key to a recipient's BTC public key.
 *
 * Generates an ephemeral secp256k1 keypair, ECDHs against the recipient,
 * and uses the result as the symmetric key. The ephemeral pubkey is
 * returned alongside the ciphertext — the recipient ECDHs with their
 * own private key + this ephemeral pubkey to recover the same secret.
 */
export function createEncryptedTipPayload(
  tipPrivateKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): { encryptedKey: string; ephemeralPubkey: string } {
  const ephemeralPrivate = generatePrivateKey();
  const ephemeralPublic = getPublicKey(ephemeralPrivate);
  const sharedSecret = deriveSharedSecret(ephemeralPrivate, recipientPublicKey);
  const encryptedKey = encrypt(tipPrivateKey, sharedSecret);

  return {
    encryptedKey: bytesToHex(encryptedKey),
    ephemeralPubkey: bytesToHex(ephemeralPublic),
  };
}

export function decryptTipPayload(
  encryptedKeyHex: string,
  ephemeralPubkeyHex: string,
  recipientPrivateKey: Uint8Array,
): Uint8Array {
  const encryptedKey = hexToBytes(encryptedKeyHex);
  const ephemeralPubkey = hexToBytes(ephemeralPubkeyHex);
  const sharedSecret = deriveSharedSecret(recipientPrivateKey, ephemeralPubkey);
  return decrypt(encryptedKey, sharedSecret);
}

/**
 * Public tip — the symmetric key lives in the URL fragment (`#…`),
 * which never reaches the server. Anyone who has the URL can decrypt;
 * the server only sees the ciphertext.
 */
export function createPublicTipPayload(
  tipPrivateKey: Uint8Array,
  urlFragmentKey: Uint8Array,
): string {
  const encrypted = encrypt(tipPrivateKey, urlFragmentKey);
  return bytesToHex(encrypted);
}

export function decryptPublicTipPayload(
  encryptedKeyHex: string,
  urlFragmentKey: Uint8Array,
): Uint8Array {
  const encrypted = hexToBytes(encryptedKeyHex);
  return decrypt(encrypted, urlFragmentKey);
}

// ============================================================================
// Bitcoin message signing (BIP-137)
// ============================================================================

function encodeVarint(n: number): Uint8Array {
  if (n < 253) {
    return new Uint8Array([n]);
  } else if (n <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    return buf;
  } else if (n <= 0xffffffff) {
    const buf = new Uint8Array(5);
    buf[0] = 0xfe;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    buf[3] = (n >> 16) & 0xff;
    buf[4] = (n >> 24) & 0xff;
    return buf;
  }
  throw new Error('Message too long for varint encoding');
}

/**
 * Bitcoin-style double-SHA256 over `"\x18Bitcoin Signed Message:\n" || varint(len) || message`.
 */
function bitcoinMessageHash(message: string): Uint8Array {
  const prefix = new TextEncoder().encode('\x18Bitcoin Signed Message:\n');
  const messageBytes = new TextEncoder().encode(message);
  const lenBytes = encodeVarint(messageBytes.length);

  const fullMessage = new Uint8Array(
    prefix.length + lenBytes.length + messageBytes.length,
  );
  fullMessage.set(prefix, 0);
  fullMessage.set(lenBytes, prefix.length);
  fullMessage.set(messageBytes, prefix.length + lenBytes.length);

  const firstHash = sha256(fullMessage);
  return sha256(firstHash);
}

/**
 * Sign a message in Bitcoin Core / Electrum BIP-137 compact format.
 *
 * Output: base64-encoded `header(1) || r(32) || s(32)` where
 * `header = 27 + recovery + 4` (the +4 marks compressed-pubkey).
 */
export function signBitcoinMessage(message: string, privateKey: Uint8Array): string {
  const msgHash = bitcoinMessageHash(message);
  const signature = secp256k1.sign(msgHash, privateKey, { lowS: true });

  const headerByte = 27 + signature.recovery + 4;

  const compactSig = new Uint8Array(65);
  compactSig[0] = headerByte;
  const rBytes = hexToBytes(signature.r.toString(16).padStart(64, '0'));
  const sBytes = hexToBytes(signature.s.toString(16).padStart(64, '0'));
  compactSig.set(rBytes, 1);
  compactSig.set(sBytes, 33);

  return btoa(String.fromCharCode(...compactSig));
}

// ============================================================================
// Encoding helpers
// ============================================================================

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Generate a URL-safe random key for public tips. Returns both the raw
 * bytes (for in-memory use) and the base64url-encoded string (for
 * embedding in `#…` URL fragments).
 */
export function generateUrlFragmentKey(): { bytes: Uint8Array; encoded: string } {
  const bytes = randomBytes(32);
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return { bytes, encoded };
}

export function decodeUrlFragmentKey(encoded: string): Uint8Array {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
