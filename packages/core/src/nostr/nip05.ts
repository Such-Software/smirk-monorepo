/**
 * NIP-05 name resolution (https://github.com/nostr-protocol/nips/blob/master/05.md).
 *
 * Resolves `name@domain` (or a bare `name` against a home domain) to its npub by
 * fetching https://<domain>/.well-known/nostr.json?name=<local>. Federation-capable:
 * it resolves ANY domain, so a Smirk wallet pays `alice@goblin.st` as natively as
 * `alice@smirk.cash`. Returns the x-only pubkey + the recipient's relay hints (for
 * NIP-17 delivery later).
 *
 * Security: "follow the key, not the name" — the npub is authoritative; the name is
 * only a lookup. Returns a graceful result (never throws) per the resilience ethos.
 */
import { hexToBytes } from '@noble/hashes/utils';
import { encodeNpub } from './identity';

export interface Nip05Resolution {
  /** x-only pubkey hex (the authoritative identity). */
  pubkeyHex: string;
  /** NIP-19 npub for display / encryption-target. */
  npub: string;
  /** Recipient DM relay hints from the well-known `relays` map (may be empty). */
  relays: string[];
}

export type Nip05Error = 'malformed' | 'unreachable' | 'not-found';
export type Nip05Result = { ok: true; resolution: Nip05Resolution } | { ok: false; error: Nip05Error };

/**
 * Split a NIP-05 identifier into `{ name, domain }`, domain lowercased. A bare
 * name (no `@`) resolves against `homeDomain`. A leading `@` is tolerated.
 */
export function splitNip05(identifier: string, homeDomain: string): { name: string; domain: string } {
  const trimmed = identifier.trim().replace(/^@/, '');
  const at = trimmed.lastIndexOf('@');
  if (at === -1) return { name: trimmed.toLowerCase(), domain: homeDomain.toLowerCase() };
  return { name: trimmed.slice(0, at).toLowerCase(), domain: trimmed.slice(at + 1).toLowerCase() };
}

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * The instance's NIP-05 "home" authority, derived from its API base URL host — so
 * a self-hosted instance treats ITS OWN domain as home (bare-name resolution + the
 * bare-vs-`name·domain` display rule) instead of the hardcoded default. Falls back
 * to `smirk.cash` when the URL can't be parsed.
 */
export function homeDomainFromApiBase(apiBase: string): string {
  try {
    return new URL(apiBase).hostname.toLowerCase();
  } catch {
    return 'smirk.cash';
  }
}

/** Resolve a NIP-05 identifier to a pubkey + relay hints. Never throws. */
export async function resolveNip05(
  identifier: string,
  opts: { homeDomain?: string; fetchImpl?: typeof fetch } = {},
): Promise<Nip05Result> {
  const homeDomain = opts.homeDomain ?? 'smirk.cash';
  const doFetch = opts.fetchImpl ?? fetch;
  const { name, domain } = splitNip05(identifier, homeDomain);
  if (!name || !domain || domain.includes('/')) return { ok: false, error: 'malformed' };

  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
  let json: { names?: Record<string, string>; relays?: Record<string, string[]> };
  try {
    const res = await doFetch(url);
    if (!res.ok) return { ok: false, error: 'unreachable' };
    json = await res.json();
  } catch {
    return { ok: false, error: 'unreachable' };
  }

  const pubkeyHex = json.names?.[name];
  if (!pubkeyHex || !HEX64.test(pubkeyHex)) return { ok: false, error: 'not-found' };
  const relays = json.relays?.[pubkeyHex] ?? [];
  return {
    ok: true,
    resolution: {
      pubkeyHex: pubkeyHex.toLowerCase(),
      npub: encodeNpub(hexToBytes(pubkeyHex)),
      relays: Array.isArray(relays) ? relays : [],
    },
  };
}
