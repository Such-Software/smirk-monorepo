/**
 * NIP-98 HTTP Auth (https://github.com/nostr-protocol/nips/blob/master/98.md).
 *
 * Builds + signs a kind-27235 event proving control of the seed-derived Nostr
 * identity, for the Authorization header. Any backend (ours, a user's, a
 * third-party dapp) verifies it with a standard BIP-340 check, so this is the
 * portable "Sign in with Smirk" credential. It is ADDITIVE: the existing
 * BTC-message-signature auth keeps working; NIP-98 buys ecosystem interop.
 *
 * Event shape (NIP-98):
 *   kind: 27235, content: "",
 *   tags: [["u", <abs url>], ["method", <HTTP method>], optional ["payload", <sha256 hex of body>]]
 * The verifier checks the u/method tags match the request, created_at is recent,
 * the optional payload hash matches the body, and the schnorr sig is valid.
 */
import { sha256 } from '@noble/hashes/sha256';
import { base64 } from '@scure/base';
import { signNostrEventId, type NostrIdentity } from './identity';

/** NIP-98 HTTP-auth event kind. */
export const NIP98_KIND = 27235;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface Nip98Params {
  /** Absolute request URL (must match the server's view of it). */
  url: string;
  /** HTTP method; normalized to upper-case. */
  method: string;
  /** Optional sha256 hex of the request body (for POST/PUT). */
  payloadSha256Hex?: string;
  /** Unix seconds; defaults to now. Injectable for tests. */
  createdAt?: number;
}

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/** NIP-01 event id: sha256 of the canonical array serialization. */
function eventId(pubkey: string, created_at: number, kind: number, tags: string[][], content: string): string {
  const serial = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  return toHex(sha256(new TextEncoder().encode(serial)));
}

/** Build + sign a NIP-98 auth event with the given identity. */
export function buildNip98Event(params: Nip98Params, identity: NostrIdentity): NostrEvent {
  const created_at = params.createdAt ?? Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ['u', params.url],
    ['method', params.method.toUpperCase()],
  ];
  if (params.payloadSha256Hex) tags.push(['payload', params.payloadSha256Hex]);
  const pubkey = identity.pubkeyHex;
  const content = '';
  const id = eventId(pubkey, created_at, NIP98_KIND, tags, content);
  const sig = signNostrEventId(id, identity.privateKey);
  return { id, pubkey, created_at, kind: NIP98_KIND, tags, content, sig };
}

/** The `Authorization` header value for a NIP-98 event: `Nostr <base64(event)>`. */
export function nip98AuthHeader(event: NostrEvent): string {
  return `Nostr ${base64.encode(new TextEncoder().encode(JSON.stringify(event)))}`;
}

/** sha256 hex of a request body, for the optional NIP-98 `payload` tag. */
export function payloadHashHex(body: string | Uint8Array): string {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return toHex(sha256(bytes));
}
