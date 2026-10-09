/**
 * Payment payloads: the structured content carried inside a NIP-17 gift-wrapped
 * rumor (kind 14) for value transfer over Nostr (P3, the Goblin convergence).
 *
 * A tip, an atomic-swap coordination step, and an interactive Grin slatepack
 * exchange are all just typed payloads on the SAME rail: a kind-1059 gift-wrap.
 * The relay only ever sees ciphertext addressed to an npub; the discriminator
 * lives in here, inside the seal, where only the recipient can read it.
 *
 * Wire shape is deliberately small + versioned so Goblin (and any future client)
 * can parse it. The rumor is tagged `["goblin","1"]` so a Goblin node recognizes
 * these as its protocol; see {@link buildPaymentRumor}.
 */

/** Protocol marker tag placed on the rumor so Goblin recognizes the payload. */
export const GOBLIN_PROTOCOL_TAG: readonly [string, string] = ['goblin', '1'];

/** NIP-17 direct-message rumor kind: the inner event a gift-wrap carries. */
export const PAYMENT_RUMOR_KIND = 14;

/** NIP-59 gift-wrap kind: the outer envelope (matches the backend relay's
 *  `GIFT_WRAP_KIND`). Filter inbox reads on `{ kinds: [GIFT_WRAP_KIND] }`. */
export const GIFT_WRAP_KIND = 1059;

/**
 * Where a Grin slatepack sits in the interactive S1→S2→S3 exchange:
 *   - `offer`    : S1 from the sender; the recipient must respond;
 *   - `response` : S2 from the recipient, back to the sender to finalize;
 *   - `finalize` : a settlement notice (S3 broadcast) closing the exchange;
 *   - `cancel`   : the sender (or recipient) abandons the exchange.
 */
export type GrinSlatepackRole = 'offer' | 'response' | 'finalize' | 'cancel';

/** An interactive Grin slatepack step. `slatepack` is absent for cancel/finalize
 *  notices; `amount` (nanogrin) rides the offer so the recipient sees the value
 *  before responding. */
export interface GrinSlatepackPayload {
  type: 'grin-slatepack';
  v: 1;
  role: GrinSlatepackRole;
  slateId: string;
  slatepack?: string;
  amount?: number;
  memo?: string;
}

/** A tip: value pushed to an npub. Shape spans interactive + non-interactive
 *  assets: `slatepack` carries an interactive Grin tip; `txid` settles a
 *  non-interactive one (XMR/BTC/…); `address` lets it double as a pay-me
 *  request. Only `asset` + `amount` are required.
 *
 *  A claimable Smirk tip also carries `tipId` and `sealedClaimKey`: the
 *  backend tip id, and the symmetric key a public share link would hold in its
 *  URL fragment, sealed a second time between sender and recipient
 *  (`sealNpubTipClaimKey` in payments/npub-tips). The gift wrap alone is not
 *  enough: the wallet lends the same Nostr key to websites through NIP-07, and
 *  a site granted `nip44.decrypt` can open the wrap and the seal. The claim key
 *  is a bearer secret, so it never appears here in the clear, and a plaintext
 *  `claimKey` field is not accepted. `expiresAt` (unix seconds) is the date
 *  after which the sender may reclaim; the backend enforces nothing until a
 *  reclaim actually runs. `to` is set only on the sender's own self-addressed
 *  copy, so the sender's history knows who the tip went to. */
export interface TipPayload {
  type: 'tip';
  v: 1;
  asset: string;
  amount: number;
  memo?: string;
  slatepack?: string;
  txid?: string;
  address?: string;
  tipId?: string;
  /** Hex `nonce || ciphertext || tag`; see the interface comment. */
  sealedClaimKey?: string;
  expiresAt?: number;
  to?: string;
}

export type PaymentPayload = GrinSlatepackPayload | TipPayload;

/** An unsigned rumor template (kind 14) ready for {@link wrapPayment}. Not a
 *  full event: `wrapEvent` stamps `pubkey`/`created_at`/`id`. */
export interface UnsignedRumor {
  kind: number;
  content: string;
  tags: string[][];
}

/**
 * Build the kind-14 rumor for a payment payload, addressed to `recipientPubkeyHex`
 * (x-only hex). Carries the NIP-17 `p` tag + the Goblin protocol marker. The
 * gift-wrap layer adds its own outer `p` tag for relay routing.
 */
export function buildPaymentRumor(
  payload: PaymentPayload,
  recipientPubkeyHex: string,
): UnsignedRumor {
  return {
    kind: PAYMENT_RUMOR_KIND,
    content: JSON.stringify(payload),
    tags: [
      ['p', recipientPubkeyHex],
      [GOBLIN_PROTOCOL_TAG[0], GOBLIN_PROTOCOL_TAG[1]],
    ],
  };
}

/** Backend tip ids are UUIDs. */
const TIP_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** A sealed claim key: XChaCha20-Poly1305 `nonce(24) || ciphertext || tag(16)`
 *  over a base64url fragment key of 20 to 128 characters, in hex. */
const SEALED_CLAIM_KEY_RE = /^[0-9a-fA-F]{120,336}$/;
const PUBKEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

const GRIN_ROLES: ReadonlySet<string> = new Set<GrinSlatepackRole>([
  'offer',
  'response',
  'finalize',
  'cancel',
]);

/**
 * Parse + validate a rumor's content into a {@link PaymentPayload}. Throws on any
 * shape the current version doesn't recognize; callers treat a throw as "not a
 * payment for us" and skip the event.
 */
export function parsePaymentPayload(content: string): PaymentPayload {
  let o: unknown;
  try {
    o = JSON.parse(content);
  } catch {
    throw new Error('payment payload is not valid JSON');
  }
  if (!o || typeof o !== 'object') throw new Error('payment payload is not an object');
  const p = o as Record<string, unknown>;

  if (p.type === 'grin-slatepack') {
    if (p.v !== 1) throw new Error('unsupported grin-slatepack version');
    if (typeof p.role !== 'string' || !GRIN_ROLES.has(p.role)) {
      throw new Error('grin-slatepack: invalid role');
    }
    if (typeof p.slateId !== 'string' || !p.slateId) {
      throw new Error('grin-slatepack: missing slateId');
    }
    const needsSlatepack = p.role === 'offer' || p.role === 'response';
    if (needsSlatepack && (typeof p.slatepack !== 'string' || !p.slatepack)) {
      throw new Error(`grin-slatepack: ${p.role} requires a slatepack`);
    }
    return {
      type: 'grin-slatepack',
      v: 1,
      role: p.role as GrinSlatepackRole,
      slateId: p.slateId,
      ...(typeof p.slatepack === 'string' ? { slatepack: p.slatepack } : {}),
      ...(typeof p.amount === 'number' ? { amount: p.amount } : {}),
      ...(typeof p.memo === 'string' ? { memo: p.memo } : {}),
    };
  }

  if (p.type === 'tip') {
    if (p.v !== 1) throw new Error('unsupported tip version');
    if (typeof p.asset !== 'string' || !p.asset) throw new Error('tip: missing asset');
    if (typeof p.amount !== 'number' || !(p.amount > 0)) throw new Error('tip: invalid amount');
    return {
      type: 'tip',
      v: 1,
      asset: p.asset,
      amount: p.amount,
      ...(typeof p.memo === 'string' ? { memo: p.memo } : {}),
      ...(typeof p.slatepack === 'string' ? { slatepack: p.slatepack } : {}),
      ...(typeof p.txid === 'string' ? { txid: p.txid } : {}),
      ...(typeof p.address === 'string' ? { address: p.address } : {}),
      // Claim fields are accepted only in their exact shapes. A malformed one
      // is dropped, not trusted: the tip then reads as informational only.
      ...(typeof p.tipId === 'string' && TIP_ID_RE.test(p.tipId) ? { tipId: p.tipId } : {}),
      ...(typeof p.sealedClaimKey === 'string' && SEALED_CLAIM_KEY_RE.test(p.sealedClaimKey)
        ? { sealedClaimKey: p.sealedClaimKey.toLowerCase() }
        : {}),
      ...(typeof p.expiresAt === 'number' && Number.isSafeInteger(p.expiresAt) && p.expiresAt > 0
        ? { expiresAt: p.expiresAt }
        : {}),
      ...(typeof p.to === 'string' && PUBKEY_HEX_RE.test(p.to) ? { to: p.to.toLowerCase() } : {}),
    };
  }

  throw new Error('unrecognized payment payload type');
}

/**
 * True when `plaintext` is a kind-14 rumor carrying a claimable Smirk tip: a
 * `tip` payload with a tip id or any claim-key field, sealed or not.
 *
 * The wallet lends its Nostr key to websites through NIP-07, and a site granted
 * `nip44.decrypt` can open a gift wrap and its seal exactly as the wallet does.
 * The decrypt executor uses this to refuse the last step for the wallet's own
 * tip rail, so a site never reads tip ids, amounts or (from a pre-release
 * wrap) a plaintext claim key. Ordinary direct messages, whose rumor content is
 * not a payment payload, are unaffected. Reads the raw fields rather than
 * {@link parsePaymentPayload}, which drops a plaintext `claimKey` on purpose.
 */
export function isClaimableTipRumor(plaintext: string): boolean {
  let rumor: unknown;
  try {
    rumor = JSON.parse(plaintext);
  } catch {
    return false;
  }
  if (!rumor || typeof rumor !== 'object') return false;
  const r = rumor as { kind?: unknown; content?: unknown };
  if (r.kind !== PAYMENT_RUMOR_KIND || typeof r.content !== 'string') return false;
  let payload: unknown;
  try {
    payload = JSON.parse(r.content);
  } catch {
    return false;
  }
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return p.type === 'tip' && ('tipId' in p || 'claimKey' in p || 'sealedClaimKey' in p);
}
