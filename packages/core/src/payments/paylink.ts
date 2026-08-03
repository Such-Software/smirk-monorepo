/**
 * GoblinPay pay-link parser (P3, Goblin/Magick Market interop). A frozen checkout
 * URI a merchant (or a Magick Market listing) hands the wallet:
 *
 *   goblin:<npub|nprofile>?amount=<GRIN>&memo=&proof=<grin1…>&order=MM-<hex>&notify=<npub>&count=<n>
 *
 * We accept both the `goblin:` and `nostr:` schemes. Parsing is pure + total:
 * every field is validated and decoded here, so the send-review UI gets a
 * structured, prefilled request it can render without re-parsing. A throw means
 * "not a pay-link we can honor"; the caller surfaces it, never guesses.
 *
 *   - `amount`:   GRIN, decimal; also converted to nanogrin (1 GRIN = 1e9 nano).
 *   - `proof`:    a `grin1…` proof address; its PRESENCE turns on native Grin
 *                 payment-proof mode (the recipient wants a signed payment proof).
 *   - `order`:    opaque `MM-<hex>` invoice id, echoed back in a payment-request tag.
 *   - `notify`:   a watcher npub the wallet gift-wraps the proof to on settlement.
 *   - `count`:    batch invoice count (≥1).
 */

import { decode as nip19decode } from 'nostr-tools/nip19';

export interface GoblinPayRequest {
  scheme: 'goblin' | 'nostr';
  /** The recipient exactly as given (npub or nprofile). */
  recipient: string;
  /** Decoded x-only pubkey hex: what the payment channel addresses. */
  recipientPubkeyHex: string;
  /** Relay hints from an nprofile, if any (empty for a bare npub). */
  recipientRelays: string[];
  /** GRIN amount as written (decimal string; preserved for display). */
  amountGrin?: string;
  /** …converted to integer nanogrin. */
  amountNanogrin?: number;
  memo?: string;
  /** `grin1…` proof address; presence ⇒ payment-proof mode. */
  proofAddress?: string;
  proofMode: boolean;
  /** Opaque `MM-<hex>` invoice id. */
  order?: string;
  /** Watcher npub to gift-wrap the proof to. */
  notify?: string;
  notifyPubkeyHex?: string;
  /** Batch invoice count (≥1). */
  count?: number;
}

const NANO_PER_GRIN = 1_000_000_000;

/** Parse a decimal GRIN string to integer nanogrin without float error. */
export function grinToNanogrin(amount: string): number {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(amount.trim());
  if (!m) throw new Error(`invalid GRIN amount: ${amount}`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? '').padEnd(9, '0'));
  const nano = whole * BigInt(NANO_PER_GRIN) + frac;
  if (nano > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`GRIN amount too large to represent exactly: ${amount}`);
  }
  return Number(nano);
}

/** Decode an npub/nprofile to `{ pubkeyHex, relays }`, or throw. */
function decodeRecipient(entity: string): { pubkeyHex: string; relays: string[] } {
  const d = nip19decode(entity);
  if (d.type === 'npub') return { pubkeyHex: d.data as string, relays: [] };
  if (d.type === 'nprofile') {
    const data = d.data as { pubkey: string; relays?: string[] };
    return { pubkeyHex: data.pubkey, relays: data.relays ?? [] };
  }
  throw new Error(`pay-link recipient must be an npub or nprofile, got ${d.type}`);
}

/** Parse a `goblin:`/`nostr:` GoblinPay URI into a structured request, or throw. */
export function parseGoblinPayUri(uri: string): GoblinPayRequest {
  const trimmed = uri.trim();
  const schemeMatch = /^(goblin|nostr):(.*)$/i.exec(trimmed);
  if (!schemeMatch) throw new Error('pay-link must use the goblin: or nostr: scheme');
  const scheme = schemeMatch[1]!.toLowerCase() as 'goblin' | 'nostr';
  const rest = schemeMatch[2]!;

  // Split "<entity>?<query>": the entity is opaque (bech32), so parse by hand
  // rather than via URL (which mangles a schemeless authority).
  const q = rest.indexOf('?');
  const entity = (q === -1 ? rest : rest.slice(0, q)).replace(/^\/\//, '');
  if (!entity) throw new Error('pay-link is missing a recipient');
  const params = new URLSearchParams(q === -1 ? '' : rest.slice(q + 1));

  const { pubkeyHex, relays } = decodeRecipient(entity);

  const amountGrin = params.get('amount') ?? undefined;
  const proofAddress = params.get('proof') ?? undefined;
  const notify = params.get('notify') ?? undefined;
  const countRaw = params.get('count') ?? undefined;

  let count: number | undefined;
  if (countRaw !== undefined) {
    count = Number(countRaw);
    if (!Number.isInteger(count) || count < 1) throw new Error(`invalid count: ${countRaw}`);
  }

  let notifyPubkeyHex: string | undefined;
  if (notify) notifyPubkeyHex = decodeRecipient(notify).pubkeyHex;

  return {
    scheme,
    recipient: entity,
    recipientPubkeyHex: pubkeyHex,
    recipientRelays: relays,
    ...(amountGrin ? { amountGrin, amountNanogrin: grinToNanogrin(amountGrin) } : {}),
    ...(params.get('memo') ? { memo: params.get('memo')! } : {}),
    ...(proofAddress ? { proofAddress } : {}),
    proofMode: Boolean(proofAddress),
    ...(params.get('order') ? { order: params.get('order')! } : {}),
    ...(notify ? { notify } : {}),
    ...(notifyPubkeyHex ? { notifyPubkeyHex } : {}),
    ...(count !== undefined ? { count } : {}),
  };
}

/** True if `uri` looks like a GoblinPay pay-link (cheap prefix test for routing). */
export function isGoblinPayUri(uri: string): boolean {
  return /^(goblin|nostr):/i.test(uri.trim());
}
