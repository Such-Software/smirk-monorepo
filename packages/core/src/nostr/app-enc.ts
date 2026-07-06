/**
 * App-scoped e2ee encryption key (X25519) — the dapp e2ee primitive.
 *
 * A deterministic, seed-derived X25519 keypair a dapp can use for server-can't-read
 * storage, WITHOUT the seed (or the private key) ever leaving the wallet. Distinct
 * from the Nostr identity (secp256k1/schnorr) — a separate curve on a separate,
 * disjoint HD path — so rotating the npub never orphans encrypted data.
 *
 * such-hq (2026-07-06) confirmed the asymmetric X25519 design over the symmetric
 * `encryptStorage`: writes are offline (seal to the pubkey, no wallet call), reads
 * are one `appSealOpen`/session, and multi-member is native (seal to each member).
 * See docs/private SESSION-PICKUP-2026-07-06.md §"Build spec" and
 * APP_SCOPED_E2EE_AND_PRIVACY.md.
 *
 * Dapp-facing (wired in dapp-api next stage):
 *   getAppEncryptionKey({ context? }) -> { publicKey (x25519 hex), scheme }
 *   appSealOpen({ sealed, context? })  -> { plaintext }
 */

import { HDKey } from '@scure/bip32';
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { blake2b } from '@noble/hashes/blake2b';
import { hsalsa, secretbox } from '@noble/ciphers/salsa';
import { bytesToHex } from '@noble/hashes/utils';

import { mnemonicToSeed } from '../hd';

/**
 * BIP-85 purpose (`83696'`) + app-encryption segment (`3'`) — disjoint from the
 * wallet chains (`44'`/`84'`), the Nostr identity (`44'/1237'`), and the reserved
 * storage(`1'`)/login(`2'`) segments. A leaked app xpub cannot walk siblings; app
 * keys are mutually unlinkable and unlinkable to identity (all segments hardened).
 */
const APP_ENC_PURPOSE = 83696;
const APP_ENC_SEGMENT = 3;
/** Load-bearing domain tag: any derivation-formula change bumps to v2 so existing
 *  ciphertext stays openable under v1. */
const DERIVATION_TAG = 'smirk:appenc:v1';
export const APP_ENC_SCHEME = 'x25519-sealedbox' as const;

/** A seed-derived, app-scoped X25519 keypair. The private key stays in core. */
export interface AppEncryptionKey {
  /** X25519 public key, 32-byte hex — what a dapp seals to. */
  publicKeyHex: string;
  /** X25519 secret key (32 bytes). Never crosses a wire; opens sealed boxes. */
  privateKey: Uint8Array;
  /** The hardened derivation path, for KATs / debugging. */
  path: string;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * The hardened path for `(domainScope, context)`. Indices are the first three
 * 32-bit big-endian words of `SHA256(tag ‖ len‖domainScope ‖ len‖context)`, each
 * masked to a hardened index. Length-prefixing both inputs removes `a‖b`
 * ambiguity; the tag namespaces the formula.
 */
export function appEncPath(domainScope: string, context = ''): string {
  const enc = new TextEncoder();
  const scope = enc.encode(domainScope.normalize('NFC'));
  const ctx = enc.encode(context.normalize('NFC'));
  const h = sha256(
    concatBytes(enc.encode(DERIVATION_TAG), u32be(scope.length), scope, u32be(ctx.length), ctx),
  );
  const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const i0 = view.getUint32(0, false) & 0x7fffffff;
  const i1 = view.getUint32(4, false) & 0x7fffffff;
  const i2 = view.getUint32(8, false) & 0x7fffffff;
  return `m/${APP_ENC_PURPOSE}'/${APP_ENC_SEGMENT}'/${i0}'/${i1}'/${i2}'`;
}

/**
 * Derive the app-scoped X25519 keypair for `(seed, domainScope, context)`.
 * Deterministic across devices/reinstalls from the seed; independent of Nostr
 * identity rotation; recoverable (re-derived on demand, nothing stored maps
 * origin → key). `domainScope` is the wallet-verified origin (or a user-confirmed
 * federation root) — the HANDLER supplies it; never a page-supplied string.
 */
export function deriveAppEncryptionKey(
  mnemonic: string,
  domainScope: string,
  context = '',
  passphrase = '',
): AppEncryptionKey {
  if (!domainScope) throw new Error('app-enc: domainScope is required');
  const path = appEncPath(domainScope, context);
  const node = HDKey.fromMasterSeed(mnemonicToSeed(mnemonic, passphrase)).derive(path);
  if (!node.privateKey) throw new Error('app-enc: failed to derive key');
  // X25519 uses the 32-byte scalar directly (clamped internally by the curve ops).
  const privateKey = node.privateKey.slice(0, 32);
  const publicKeyHex = bytesToHex(x25519.getPublicKey(privateKey));
  return { publicKeyHex, privateKey, path };
}

/**
 * Salsa20/ChaCha "expand 32-byte k" constant, as four little-endian 32-bit words.
 * Used as the HSalsa20 constant input for `crypto_box_beforenm`.
 */
const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

/** Decode bytes → little-endian u32 words (host-endian-independent; Salsa is LE). */
function bytesToU32LE(b: Uint8Array): Uint32Array {
  const out = new Uint32Array(b.length >>> 2);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}

/** Encode little-endian u32 words → bytes (inverse of `bytesToU32LE`). */
function u32ToBytesLE(w: Uint32Array): Uint8Array {
  const out = new Uint8Array(w.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < w.length; i++) view.setUint32(i * 4, w[i] ?? 0, true);
  return out;
}

/**
 * `crypto_box_beforenm`: reduce a raw X25519 shared point to the 32-byte
 * XSalsa20-Poly1305 box key via `HSalsa20(sigma, shared, 0^16)`.
 */
function cryptoBoxBeforenm(shared: Uint8Array): Uint8Array {
  const out32 = new Uint32Array(8);
  hsalsa(SIGMA, bytesToU32LE(shared), bytesToU32LE(new Uint8Array(16)), out32);
  return u32ToBytesLE(out32);
}

/**
 * Open a libsodium `crypto_box_seal` given the recipient's X25519 secret key —
 * the pure primitive, no derivation. Byte-exact with libsodium (KAT'd in
 * `app-enc-seal.test.ts`); throws on a bad tag (wrong key / tampered box).
 *
 *   sealed   = ephemPk(32) ‖ ciphertext
 *   nonce    = blake2b(ephemPk ‖ recipPk, dkLen=24)   // crypto_generichash, unkeyed
 *   shared   = X25519(secretKey, ephemPk)             // raw crypto_scalarmult
 *   boxKey   = HSalsa20(sigma, shared, 0^16)          // crypto_box_beforenm
 *   plaintext= secretbox(boxKey, nonce).open(ct)      // xsalsa20poly1305
 */
export function sealOpen(recipientSecretKey: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (recipientSecretKey.length !== 32) throw new Error('app-enc: secret key must be 32 bytes');
  if (sealed.length < 32 + 16) throw new Error('app-enc: sealed box too short');
  const ephemPk = sealed.slice(0, 32);
  const ciphertext = sealed.slice(32);
  const recipPk = x25519.getPublicKey(recipientSecretKey);
  const nonce = blake2b(concatBytes(ephemPk, recipPk), { dkLen: 24 });
  const shared = x25519.getSharedSecret(recipientSecretKey, ephemPk);
  const boxKey = cryptoBoxBeforenm(shared);
  return secretbox(boxKey, nonce).open(ciphertext);
}

/**
 * Open a libsodium `crypto_box_seal` addressed to the app-scoped key — the read
 * side of the dapp envelope. Re-derives the key from the seed (the private key
 * never leaves the wallet), then opens. `sealed` is the raw envelope bytes; the
 * dapp-api transport layer owns base64/hex framing. Returns the raw plaintext
 * bytes (the caller utf8-decodes if the payload is text).
 */
export function appSealOpen(
  mnemonic: string,
  domainScope: string,
  sealed: Uint8Array,
  context = '',
  passphrase = '',
): Uint8Array {
  const key = deriveAppEncryptionKey(mnemonic, domainScope, context, passphrase);
  return sealOpen(key.privateKey, sealed);
}
