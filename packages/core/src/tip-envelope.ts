/**
 * Versioned envelope for targeted tip payloads, with a per-coin encryption
 * target.
 *
 * ## Why this exists
 *
 * Every targeted tip used to be ECIES-encrypted to the recipient's registered
 * **BTC** public key, whatever asset was being sent. A Grin-only or Monero-only
 * recipient still had their tip keyed to a secp256k1 key from a chain they may
 * never touch, and Litecoin was encrypted to the Bitcoin key despite having a
 * perfectly good registered key of its own.
 *
 * Here each asset is encrypted to a key that belongs to that asset:
 *
 * | asset | target                                    | suite |
 * |-------|-------------------------------------------|-------|
 * | btc   | registered secp256k1 public key           | 0x01  |
 * | ltc   | registered secp256k1 public key           | 0x01  |
 * | xmr   | per-asset ed25519 encryption subkey       | 0x02  |
 * | wow   | per-asset ed25519 encryption subkey       | 0x02  |
 * | grin  | canonical `grin1…` slatepack address      | 0x03  |
 *
 * ## Why XMR/WOW do not use the spend key
 *
 * The obvious target is the registered `publicSpendKey`, and it is the wrong
 * one. That scalar is already an arbitrary-message ed25519 signing oracle
 * reachable by dapps (`dapp-popup/signers.ts` signs with
 * `wallet.keys.xmr.privateSpendKey`), and it is the spend authority for the
 * funds. Adding key agreement would make one secret serve three roles at once.
 * A separate encryption subkey costs one derivation and keeps those roles apart.
 *
 * It also would not work without a bespoke scheme: `age` pairs an X25519 secret
 * `SHA512(seed)[0..32]` with a public key formed as `G·clamp(SHA512(seed))`,
 * while a Monero spend key is a raw reduced scalar with no clamping. The subkey
 * is a standard ed25519 keypair, so stock `age` applies unchanged.
 *
 * ## Wire format
 *
 * ```
 *   byte 0    0x01        envelope version
 *   byte 1    suite id    see TipSuite
 *   byte 2    asset id    see TIP_ASSET_ID
 *   byte 3..  suite body
 * ```
 *
 * The 3-byte header is bound into the ciphertext: as AEAD associated data for
 * suite 0x01, and by `age`'s own header MAC for 0x02/0x03. A tampered header
 * therefore fails authentication rather than quietly selecting another suite.
 *
 * ## Telling an envelope apart from a legacy payload
 *
 * A pre-envelope targeted payload begins with a compressed secp256k1 point, so
 * its first byte is always `0x02` or `0x03`. Version `0x01` cannot collide with
 * one. The cost is that envelope versions `0x02` and `0x03` are permanently
 * burned: a future v2 has to use `0x04`.
 *
 * Public-link tips carry no envelope at all and are claimed through a different
 * entry point, so they never reach this discrimination.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1';

import { decryptWithAad, encryptWithAad, getPublicKey, randomBytes } from './crypto';
import type { AssetType } from './types';

/** Envelope version. See the module docs on why 0x02/0x03 can never be used. */
export const TIP_ENVELOPE_VERSION = 0x01;

/** Encryption suite: how the body is protected, not which coin is being sent. */
export const TipSuite = {
  /** secp256k1 ECDH → HKDF-SHA256 → XChaCha20-Poly1305. */
  Secp256k1Ecies: 0x01,
  /** `age` to an ed25519 encryption subkey. */
  AgeEd25519: 0x02,
  /** `age` to a `grin1…` slatepack address. */
  AgeSlatepack: 0x03,
} as const;
export type TipSuiteId = (typeof TipSuite)[keyof typeof TipSuite];

/** Asset byte. Present so a payload is self-describing even out of context. */
export const TIP_ASSET_ID: Record<AssetType, number> = {
  btc: 0x01,
  ltc: 0x02,
  xmr: 0x03,
  wow: 0x04,
  grin: 0x05,
};

/** The suite each asset is encrypted under. */
export const TIP_ASSET_SUITE: Record<AssetType, TipSuiteId> = {
  btc: TipSuite.Secp256k1Ecies,
  ltc: TipSuite.Secp256k1Ecies,
  xmr: TipSuite.AgeEd25519,
  wow: TipSuite.AgeEd25519,
  grin: TipSuite.AgeSlatepack,
};

/** Which registered key an asset's tip is encrypted to. */
export const TIP_TARGET_KEY_TYPE: Record<AssetType, 'primary' | 'enc' | 'slatepack'> = {
  btc: 'primary',
  ltc: 'primary',
  xmr: 'enc',
  wow: 'enc',
  grin: 'slatepack',
};

const HEADER_LEN = 3;
const EPH_PUBKEY_LEN = 33;

/** HKDF `info`, per suite. Domain separation so one suite's key is never another's. */
const SUITE_INFO: Record<number, string> = {
  [TipSuite.Secp256k1Ecies]: 'smirk-tip/v1/secp256k1-ecies',
};

export interface TipEnvelope {
  version: number;
  suite: number;
  asset: number;
  /** The suite-specific body; the header is NOT included. */
  body: Uint8Array;
  /** The 3 header bytes, as authenticated. */
  header: Uint8Array;
}

/** Build the 3-byte header for `asset` under its suite. */
export function tipHeader(asset: AssetType): Uint8Array {
  return new Uint8Array([TIP_ENVELOPE_VERSION, TIP_ASSET_SUITE[asset], TIP_ASSET_ID[asset]]);
}

/**
 * Does this payload use the envelope, or is it a pre-envelope targeted payload?
 *
 * Reads only the first byte, so a truncated or malformed payload is reported as
 * legacy and fails later in the legacy parser rather than here.
 */
export function isTipEnvelope(payload: Uint8Array): boolean {
  return payload.length > HEADER_LEN && payload[0] === TIP_ENVELOPE_VERSION;
}

/** Split a payload into header and body. Throws if it is not an envelope. */
export function parseTipEnvelope(payload: Uint8Array): TipEnvelope {
  if (!isTipEnvelope(payload)) {
    throw new Error('not a Smirk tip envelope');
  }
  const header = payload.slice(0, HEADER_LEN);
  const [version, suite, asset] = header;
  if (version === undefined || suite === undefined || asset === undefined) {
    throw new Error('tip envelope header truncated');
  }
  return {
    version,
    suite,
    asset,
    header,
    body: payload.slice(HEADER_LEN),
  };
}

/**
 * Suite 0x01 key schedule.
 *
 * The input keying material is the **33-byte compressed** shared point,
 * including its `0x02`/`0x03` prefix, which is what `secp256k1.getSharedSecret`
 * returns by default. Textbook ECIES usually hashes the 32-byte x-coordinate
 * instead; both are sound, but an implementer who assumes the other one derives
 * a different key and gets an authentication failure with nothing to debug. It
 * is written out here because a spec that says only "secp256k1 ECIES" is not
 * enough to reimplement this.
 *
 * Both public keys are in the salt so the derived key is bound to the specific
 * pair, not just to the shared point.
 */
function suite01Key(
  sharedPoint: Uint8Array,
  ephPub: Uint8Array,
  recipientPub: Uint8Array,
): Uint8Array {
  const salt = new Uint8Array(ephPub.length + recipientPub.length);
  salt.set(ephPub, 0);
  salt.set(recipientPub, ephPub.length);
  return hkdf(sha256, sharedPoint, salt, SUITE_INFO[TipSuite.Secp256k1Ecies], 32);
}

/**
 * Encrypt `keyMaterial` to a secp256k1 public key (btc, ltc).
 *
 * Body is `ephPubCompressed(33) || nonce(24) || ciphertext || tag(16)`.
 */
export function sealSecp256k1(
  keyMaterial: Uint8Array,
  recipientPub: Uint8Array,
  header: Uint8Array,
): Uint8Array {
  // Reject a malformed or off-curve recipient key before it reaches the
  // multiply, so a bad directory entry is a clear error rather than a
  // hard-to-place exception from deep inside the curve library.
  secp256k1.ProjectivePoint.fromHex(recipientPub).assertValidity();

  const ephPriv = randomBytes(32);
  const ephPub = getPublicKey(ephPriv, true);
  const shared = secp256k1.getSharedSecret(ephPriv, recipientPub);
  const key = suite01Key(shared, ephPub, recipientPub);
  const sealed = encryptWithAad(keyMaterial, key, header);

  const out = new Uint8Array(header.length + ephPub.length + sealed.length);
  out.set(header, 0);
  out.set(ephPub, header.length);
  out.set(sealed, header.length + ephPub.length);
  return out;
}

/** Inverse of {@link sealSecp256k1}. */
export function openSecp256k1(
  envelope: TipEnvelope,
  recipientPriv: Uint8Array,
): Uint8Array {
  const ephPub = envelope.body.slice(0, EPH_PUBKEY_LEN);
  if (ephPub.length !== EPH_PUBKEY_LEN) {
    throw new Error('tip envelope truncated before the ephemeral key');
  }
  // The ephemeral key is attacker-supplied; validate before the multiply.
  secp256k1.ProjectivePoint.fromHex(ephPub).assertValidity();

  const recipientPub = getPublicKey(recipientPriv, true);
  const shared = secp256k1.getSharedSecret(recipientPriv, ephPub);
  const key = suite01Key(shared, ephPub, recipientPub);
  return decryptWithAad(envelope.body.slice(EPH_PUBKEY_LEN), key, envelope.header);
}

/**
 * The `age` operations, injected rather than imported.
 *
 * Suites 0x02 and 0x03 are `age` over X25519, which lives in Rust/wasm. Taking
 * it as a parameter keeps this module free of a wasm-init dependency, so the
 * envelope codec and the secp256k1 suite stay unit-testable without one.
 */
export interface AgeSealer {
  /** Encrypt to a raw 32-byte ed25519 public key. */
  seal(payload: Uint8Array, recipientEd25519Pub: Uint8Array): Uint8Array;
  /** Decrypt with the raw 32-byte ed25519 secret seed. */
  open(body: Uint8Array, ed25519Seed: Uint8Array): Uint8Array;
}

/** Encrypt `keyMaterial` under an `age` suite (xmr, wow, grin). */
export function sealAge(
  keyMaterial: Uint8Array,
  recipientEd25519Pub: Uint8Array,
  header: Uint8Array,
  age: AgeSealer,
): Uint8Array {
  const body = age.seal(keyMaterial, recipientEd25519Pub);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

/** Inverse of {@link sealAge}. */
export function openAge(
  envelope: TipEnvelope,
  ed25519Seed: Uint8Array,
  age: AgeSealer,
): Uint8Array {
  return age.open(envelope.body, ed25519Seed);
}
