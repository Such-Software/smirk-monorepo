/**
 * Messages a website may never have the wallet sign.
 *
 * Every proof a Smirk wallet server accepts from a wallet key starts with
 * `smirk-`: the sign-in challenge (`smirk-auth-<ts>`), the pre-v0.3 identity
 * rotation proof (`smirk-auth-rotate-v2|<api>|<key hash>|<ts>`; servers before
 * `legacy_merge_v2` took `smirk-rotate-v1|...`), and whatever the server adds
 * next. Each is predictable to an outsider, so a connected site that gets one
 * signed can replay it to the user's own server. A signed rotation message
 * bound to the attacker's key is enough for the server's legacy merge to move
 * the user's handle, npub and tips to the attacker's account. (The v2 proof
 * also starts with `smirk-auth-`, which the shipped v0.3.0 signer refuses.)
 *
 * So the whole `smirk-` namespace is reserved, not a list of known prefixes: a
 * list missed `smirk-rotate-` once, and a new server proof should not depend on
 * someone remembering to extend it. The wallet signs its own proofs in core,
 * never through the dapp surface, so this refuses no legitimate request. The
 * smirk.cash website's own challenge starts with "Smirk Authentication
 * Challenge", which is not in the namespace.
 */
const RESERVED_SMIRK_MESSAGE = /^\s*smirk-/i;

/** True when `message` is in the reserved `smirk-` namespace. */
export function isReservedSmirkMessage(message: unknown): boolean {
  return typeof message === 'string' && RESERVED_SMIRK_MESSAGE.test(message);
}

/** The refusal shown to the page, with the reason. */
export const RESERVED_SMIRK_MESSAGE_REFUSAL =
  'Refusing to sign a message that starts with "smirk-": that namespace is reserved for proofs the Smirk wallet server accepts, and a website could replay the signature to it.';

/**
 * A Smirk server's "sign in with your wallet" challenge, as
 * `/auth/website/challenge` issues it:
 * `Smirk Authentication Challenge\nNonce: …\nOrigin: <website>\nTimestamp: …`.
 *
 * That challenge is MEANT to be signed through this surface, by the website it
 * names, and the server trades the signature for a full session. A website
 * that fetched a challenge naming some other site (or relayed one from the
 * server) and got it signed here could sign in to that server as the user. So
 * the wallet signs a Smirk challenge only for the site it names; servers from
 * 2026-10-09 also issue challenges only for their own websites.
 */
const WEBSITE_CHALLENGE = /^\s*smirk authentication challenge\s*\n/i;

/** An origin as compared here: trimmed, lowercase, without a trailing `/`. */
function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Why the wallet refuses to sign `message` for `requestingOrigin`, or `null`.
 *
 * Refuses a Smirk website sign-in challenge unless it names exactly one
 * origin and that origin is the requesting site. Any other message is not
 * this function's business (`null`).
 */
export function websiteChallengeOriginRefusal(message: unknown, requestingOrigin: string): string | null {
  if (typeof message !== 'string' || !WEBSITE_CHALLENGE.test(message)) return null;
  const named = [...message.matchAll(/^\s*origin:[ \t]*(\S*)[ \t]*$/gim)].map((m) => m[1] ?? '');
  if (named.length !== 1 || !named[0]) {
    return 'Refusing to sign a Smirk sign-in challenge that does not name exactly one website.';
  }
  if (normalizeOrigin(named[0]) !== normalizeOrigin(requestingOrigin)) {
    return `Refusing to sign a Smirk sign-in challenge for ${named[0]} requested by ${requestingOrigin}: a website may only sign in to Smirk as itself.`;
  }
  return null;
}
