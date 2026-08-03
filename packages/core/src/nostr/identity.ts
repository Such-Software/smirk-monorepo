/**
 * Nostr identity derivation (NIP-06) for the Smirk wallet.
 *
 * The identity key is derived from the SAME seed as the wallet, at the NIP-06
 * path m/44'/1237'/<account>'/0/0. The hardened ACCOUNT index is the rotation
 * counter: account 0 is the default identity; advancing it produces a fresh,
 * seed-recoverable, externally-unlinkable npub (the account is hardened, so leaf
 * keys cannot be linked even with a leaked xpub).
 *
 * The npub is a standard NIP-19 bech32 encoding of the x-only (schnorr) pubkey,
 * so it interoperates with any Nostr client (e.g. Goblin). This is the identity
 * layer the MessagingProvider (default: Nostr) and NIP-98 sign-in build on; the
 * per-coin signing keys are unaffected.
 */
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bech32 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey } from 'nostr-tools/pure';
import { deriveNostrKeyFromSeed, mnemonicToSeed } from '../hd';

/** Sentinel `account` for a NON-seed-derived identity (imported nsec or a random
 *  burner). The identity store tracks the real source; this just flags "not
 *  rotation-derivable from the seed" on the NostrIdentity itself. */
export const NON_DERIVED_ACCOUNT = -1;

/** bech32 length cap; npub is ~63 chars, this is generous headroom. */
const BECH32_LIMIT = 1000;

export interface NostrIdentity {
  /** Hardened account index = the rotation counter (0 = default identity). */
  account: number;
  /** NIP-19 public identity, `npub1...`. */
  npub: string;
  /** x-only (schnorr) public key, 32-byte hex: the on-wire Nostr pubkey. */
  pubkeyHex: string;
  /** secp256k1 secret key (32 bytes). Stays in core; used to sign events. */
  privateKey: Uint8Array;
}

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/** Encode a 32-byte x-only pubkey as a NIP-19 `npub`. */
export function encodeNpub(pubkeyXOnly: Uint8Array): string {
  return bech32.encode('npub', bech32.toWords(pubkeyXOnly), BECH32_LIMIT);
}

/** Decode an `npub` back to its 32-byte x-only pubkey (throws on bad input). */
export function decodeNpub(npub: string): Uint8Array {
  const { prefix, words } = bech32.decode(npub as `npub1${string}`, BECH32_LIMIT);
  if (prefix !== 'npub') throw new Error(`not an npub: ${prefix}`);
  return new Uint8Array(bech32.fromWords(words));
}

/**
 * Derive the Nostr identity at a hardened account (default 0). Rotation is just
 * `deriveNostrIdentity(mnemonic, account + 1)`.
 */
export function deriveNostrIdentity(mnemonic: string, account = 0, passphrase = ''): NostrIdentity {
  // Single derivation path: `deriveNostrKeyFromSeed` (in ../hd) validates the
  // account index and derives m/44'/1237'/<account>'/0/0. Keeping it there
  // avoids an import cycle (hd.ts must not import identity.ts) and guarantees
  // this identity and `deriveAllKeys().nostr` can never drift apart.
  const seed = mnemonicToSeed(mnemonic, passphrase);
  const { privateKey, publicKey } = deriveNostrKeyFromSeed(seed, account);
  return {
    account,
    npub: encodeNpub(publicKey),
    pubkeyHex: toHex(publicKey),
    privateKey,
  };
}

/**
 * Build a NostrIdentity from a raw 32-byte secret key, for an imported `nsec` or
 * a random "burner". `account` is {@link NON_DERIVED_ACCOUNT} because it isn't
 * seed-rotation-derivable; the identity store records the real source.
 */
export function nostrIdentityFromPrivkey(privateKey: Uint8Array): NostrIdentity {
  if (privateKey.length !== 32) throw new Error('nostr secret key must be 32 bytes');
  const pubkeyXOnly = schnorr.getPublicKey(privateKey);
  return {
    account: NON_DERIVED_ACCOUNT,
    npub: encodeNpub(pubkeyXOnly),
    pubkeyHex: toHex(pubkeyXOnly),
    privateKey,
  };
}

// ── per-origin Nostr identity (opt-in dapp compartmentalization) ──────────────
// BIP-85 purpose (83696') + a per-origin-Nostr segment (4'): disjoint from the
// wallet chains (44'/84'), the NIP-06 identity (44'/1237'), app-enc (83696'/3'),
// and the reserved storage(1')/login(2') segments. Deterministic + recoverable
// from the seed (reinstall keeps the same per-site npub) and unlinkable across
// origins (all hardened). A change to the formula bumps the tag to v2.
const NOSTR_ORIGIN_PURPOSE = 83696;
const NOSTR_ORIGIN_SEGMENT = 4;
const NOSTR_ORIGIN_TAG = 'smirk:nostr-origin:v1';

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function concatU8(...parts: Uint8Array[]): Uint8Array {
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
 * Hardened path for a per-origin Nostr identity. Indices are the first three 32-bit
 * big-endian words of `SHA256(tag ‖ len‖origin)`, each masked to a hardened index.
 * Length-prefixing removes `a‖b` ambiguity; the tag namespaces the formula.
 */
export function nostrOriginPath(origin: string): string {
  const enc = new TextEncoder();
  const scope = enc.encode(origin.normalize('NFC'));
  const h = sha256(concatU8(enc.encode(NOSTR_ORIGIN_TAG), u32be(scope.length), scope));
  const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const i0 = view.getUint32(0, false) & 0x7fffffff;
  const i1 = view.getUint32(4, false) & 0x7fffffff;
  const i2 = view.getUint32(8, false) & 0x7fffffff;
  return `m/${NOSTR_ORIGIN_PURPOSE}'/${NOSTR_ORIGIN_SEGMENT}'/${i0}'/${i1}'/${i2}'`;
}

/**
 * Derive a deterministic, seed-recoverable Nostr identity SCOPED to a verified
 * origin, for opt-in per-dapp compartmentalization. Unlike a random burner it
 * survives reinstall (re-derived from the seed); unlike account-0 it is unlinkable
 * to the user's main npub. `origin` MUST be the wallet-verified origin (the handler
 * supplies it), never a page-supplied string. `account` is
 * {@link NON_DERIVED_ACCOUNT} (it is not a NIP-06 rotation account).
 */
export function deriveNostrIdentityForOrigin(
  mnemonic: string,
  origin: string,
  passphrase = '',
): NostrIdentity {
  if (!origin) throw new Error('nostr-origin: origin is required');
  const node = HDKey.fromMasterSeed(mnemonicToSeed(mnemonic, passphrase)).derive(
    nostrOriginPath(origin),
  );
  if (!node.privateKey) throw new Error('nostr-origin: failed to derive key');
  return nostrIdentityFromPrivkey(node.privateKey.slice(0, 32));
}

/**
 * A fresh RANDOM "burner" identity: deliberately NOT seed-derived. Rationale
 * (matches Goblin's stance): a leaked seed can't derive it (stronger
 * compartmentalization), and it's cross-wallet-portable as an `nsec`. The secret
 * is the ONLY backup; the identity store encrypts it at rest.
 */
export function generateBurnerIdentity(): NostrIdentity {
  return nostrIdentityFromPrivkey(generateSecretKey());
}

/** Decode an `nsec` (NIP-19) to its 32-byte secret key (throws on bad input). */
export function decodeNsec(nsec: string): Uint8Array {
  const { prefix, words } = bech32.decode(nsec as `nsec1${string}`, BECH32_LIMIT);
  if (prefix !== 'nsec') throw new Error(`not an nsec: ${prefix}`);
  const key = new Uint8Array(bech32.fromWords(words));
  if (key.length !== 32) throw new Error('nsec did not decode to a 32-byte key');
  return key;
}

/** Encode a 32-byte secret key as an `nsec` (for per-identity export/backup). */
export function encodeNsec(privateKey: Uint8Array): string {
  if (privateKey.length !== 32) throw new Error('nostr secret key must be 32 bytes');
  return bech32.encode('nsec', bech32.toWords(privateKey), BECH32_LIMIT);
}

/** Import an identity from an `nsec` string (e.g. carried over from Goblin). */
export function importNostrIdentity(nsec: string): NostrIdentity {
  return nostrIdentityFromPrivkey(decodeNsec(nsec));
}

/**
 * Schnorr-sign a Nostr event id (the 32-byte sha256 of the serialized event,
 * as hex) with the identity key. Returns the 64-byte signature as hex. This is
 * the primitive NIP-01 events and NIP-98 auth sign over.
 */
export function signNostrEventId(eventIdHex: string, privateKey: Uint8Array): string {
  return toHex(schnorr.sign(eventIdHex, privateKey));
}

/** Verify a 64-byte hex signature over an event id against an x-only pubkey hex. */
export function verifyNostrEventId(sigHex: string, eventIdHex: string, pubkeyHex: string): boolean {
  return schnorr.verify(sigHex, eventIdHex, pubkeyHex);
}

export interface UnsignedNostrEvent {
  kind: number;
  content: string;
  tags: string[][];
  /** Unix seconds; the wallet stamps `now` when omitted. */
  created_at?: number;
}

export interface SignedNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** NIP-01 event id: sha256 of the canonical array serialization. */
function nostrEventIdHex(
  pubkey: string,
  created_at: number,
  kind: number,
  tags: string[][],
  content: string,
): string {
  const serial = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  return toHex(sha256(new TextEncoder().encode(serial)));
}

/**
 * Finalize + schnorr-sign an arbitrary Nostr event (NIP-01) with the identity:
 * stamp pubkey + created_at (now when omitted), compute the id, sign it. The
 * general primitive that dapp signing (NIP-98 login, kind-1 notes) builds on.
 */
export function signNostrEvent(
  unsigned: UnsignedNostrEvent,
  identity: NostrIdentity,
): SignedNostrEvent {
  const created_at = unsigned.created_at ?? Math.floor(Date.now() / 1000);
  const pubkey = identity.pubkeyHex;
  const tags = unsigned.tags ?? [];
  const content = unsigned.content ?? '';
  const id = nostrEventIdHex(pubkey, created_at, unsigned.kind, tags, content);
  const sig = signNostrEventId(id, identity.privateKey);
  return { id, pubkey, created_at, kind: unsigned.kind, tags, content, sig };
}
