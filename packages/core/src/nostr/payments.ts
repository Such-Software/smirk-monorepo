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
 *  request. Only `asset` + `amount` are required. */
export interface TipPayload {
  type: 'tip';
  v: 1;
  asset: string;
  amount: number;
  memo?: string;
  slatepack?: string;
  txid?: string;
  address?: string;
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
    };
  }

  throw new Error('unrecognized payment payload type');
}
