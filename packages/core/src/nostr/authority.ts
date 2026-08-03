/**
 * How to DISPLAY a Nostr identity: the federation-aware naming rule. A pubkey can
 * be known by several handles; we show the most trustworthy, most human one:
 *
 *   petname  >  verified home name  >  verified foreign name·domain  >  short npub
 *
 *   - petname            : a local contact label the user set. Highest trust (they
 *                          named it) and never ambiguous.
 *   - verified home name : `alice` (bare) with a check, when the name is on our own
 *                          authority and resolved to THIS pubkey.
 *   - verified foreign   : `alice·goblin.st` with a check, when a cross-domain
 *                          (federated) name resolved to this pubkey. The domain is
 *                          shown so the user sees WHICH authority vouches for it.
 *   - short npub         : `npub1abcd…wxyz` when nothing better is known. No check.
 *
 * "Follow the key, not the name": the check means "this NAME currently resolves to
 * this KEY", never "this key is trustworthy". An unverified name is NOT shown as a
 * name at all; it falls through to the npub, so a spoofed handle can't masquerade.
 */

export interface NostrAuthorityDisplay {
  /** The text to render. */
  label: string;
  /** Whether to show a verified check next to the label. */
  verified: boolean;
  /** Longer form for a tooltip / secondary line (the full npub + name). */
  title: string;
}

/** `npub1abcd…wxyz`: first 9 + last 4 chars, enough to eyeball but compact. */
export function shortNpub(npub: string): string {
  if (npub.length <= 15) return npub;
  return `${npub.slice(0, 9)}…${npub.slice(-4)}`;
}

export function formatNostrAuthority(input: {
  npub: string;
  /** A resolved NIP-05 identifier `name@domain`, if any. */
  nip05?: string | undefined;
  /** True only when `nip05` was RESOLVED to this npub (follow-the-key). An
   *  unverified name is ignored; we never show an unproven handle as a name. */
  verified?: boolean | undefined;
  /** A local contact label the user set for this pubkey. */
  petname?: string | undefined;
  /** Our own authority; a verified name here shows bare (no domain). */
  homeDomain?: string | undefined;
}): NostrAuthorityDisplay {
  const homeDomain = (input.homeDomain ?? 'smirk.cash').toLowerCase();
  const npubShort = shortNpub(input.npub);

  if (input.petname && input.petname.trim()) {
    return { label: input.petname.trim(), verified: true, title: `${input.petname.trim()} · ${input.npub}` };
  }

  if (input.verified && input.nip05 && input.nip05.includes('@')) {
    const at = input.nip05.lastIndexOf('@');
    const name = input.nip05.slice(0, at).toLowerCase();
    const domain = input.nip05.slice(at + 1).toLowerCase();
    const label = domain === homeDomain ? name : `${name}·${domain}`;
    return { label, verified: true, title: `${input.nip05} · ${input.npub}` };
  }

  return { label: npubShort, verified: false, title: input.npub };
}
