/**
 * Resolve the tip composer's recipient field to the npub that will receive
 * the claim key: an npub, a 64-char hex key, a `name@domain` Nostr address,
 * or a bare Smirk username looked up on this instance's NIP-05 domain.
 */
import { encodeNpub, hexToBytes, recipientToHex, resolveNip05, shortNpub } from '@smirk/core';
import type { TipRecipient } from '@smirk/ui';
import { nip05HomeDomain } from './nip05';

type Resolve = typeof resolveNip05;

/** A hex pubkey in the app's short npub form (`npub1abcd…wxyz`). */
export function shortNpubFromHex(pubkeyHex: string): string {
  return shortNpub(encodeNpub(hexToBytes(pubkeyHex)));
}

const NIP05_ERRORS: Record<string, string> = {
  malformed: 'That address is not valid',
  unreachable: 'Could not reach that address right now',
  'not-found': 'No one by that name',
};

export async function resolveTipRecipient(
  text: string,
  deps: { resolve?: Resolve; homeDomain?: string } = {},
): Promise<{ ok: true; recipient: TipRecipient } | { ok: false; error: string }> {
  const raw = text.trim().replace(/^@/, '');
  if (!raw) return { ok: false, error: 'Enter a recipient' };

  // A key typed directly: no lookup.
  if (raw.startsWith('npub1') || /^[0-9a-fA-F]{64}$/.test(raw)) {
    try {
      const pubkeyHex = recipientToHex(raw);
      return { ok: true, recipient: { pubkeyHex, display: shortNpubFromHex(pubkeyHex) } };
    } catch {
      return { ok: false, error: 'That npub is not valid' };
    }
  }

  // `name@domain`, or a bare Smirk username on this instance's domain.
  const homeDomain = deps.homeDomain ?? nip05HomeDomain();
  const resolve = deps.resolve ?? resolveNip05;
  const r = await resolve(raw, { homeDomain });
  if (!r.ok) return { ok: false, error: NIP05_ERRORS[r.error] ?? 'Could not find that recipient' };
  const display = raw.includes('@') ? raw.toLowerCase() : `@${raw.toLowerCase()}`;
  return { ok: true, recipient: { pubkeyHex: r.resolution.pubkeyHex, display } };
}
