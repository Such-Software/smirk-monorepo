/**
 * GRINVCH1: the wire format of a Grin voucher.
 *
 * A voucher is a Grin output the sender has already created and broadcast,
 * handed over as data rather than as an interactive transaction. Whoever holds
 * the blinding factor can sweep the commitment into their own keychain at any
 * later time, with no round trip and with the sender long gone. That is what
 * makes a Grin tip work at all: Grin has no addresses to pay into, so a
 * non-interactive transfer has to move the secret, not the coins.
 *
 * The format is versioned and named because it is the durable artifact. It
 * outlives the tip row, the backend and this wallet, and the only thing
 * standing between a recipient and their funds is a parser somewhere being
 * able to read it. A bare, untagged JSON object was not a thing another wallet
 * could implement against.
 *
 * ## The fields
 *
 *   grinvch   format version, always 1 here. Its presence is the discriminator.
 *   commit    the Pedersen commitment, hex. Identifies the output on-chain.
 *   proof     the range proof, hex. Not needed to spend; see below.
 *   features  output features, numeric (0 = Plain).
 *   blind     THE SECRET. The blinding factor, hex. Spend authority.
 *   amount    value in nanogrin, as a DECIMAL STRING.
 *
 * `amount` is a string because it is a u64 and JSON numbers are doubles.
 * Nanogrin crosses 2^53 at about nine million GRIN, so a number is not wrong
 * today for a tip, but a format that silently rounds at some threshold is a
 * trap for whoever implements against it later, and the two most recent
 * amount bugs in this codebase were both exactly that. Note the wasm boundary
 * still passes amounts as numbers, so the pipeline is not yet lossless end to
 * end; this fixes the part that is written down and handed to strangers.
 *
 * `proof` is carried even though sweeping never reads it. It is what lets a
 * recipient, or a third party handed a voucher out of band, verify the
 * commitment is well formed and matches the stated amount before believing
 * any of it. A voucher without the proof is a claim; with it, it is evidence.
 *
 * The sender's BIP32 child index is deliberately NOT carried. Sweeping never
 * needed it, and it says which output of the sender's wallet this came from,
 * which is the sender's business and not the recipient's.
 *
 * ## Framing
 *
 * A voucher is NEVER wrapped in a SlatepackBin. Slatepack mode 1 contractually
 * carries a serialized SlateV4, so a conforming wallet decrypts a voucher
 * cleanly and then dies parsing it as a slate, which reads as corruption
 * rather than as "this is a different kind of thing".
 */

/** The `grinvch` version this module writes. */
export const GRIN_VOUCHER_VERSION = 1;

/** A voucher in its canonical, parsed form. */
export interface GrinVoucher {
  /** Pedersen commitment, hex. */
  commit: string;
  /** Range proof, hex. */
  proof: string;
  /** Output features; 0 is Plain. */
  features: number;
  /** SECRET: the blinding factor, hex. Spend authority over `commit`. */
  blind: string;
  /** Value in nanogrin. */
  amount: bigint;
}

/**
 * The pre-GRINVCH1 shape: an untagged object with longer field names and a
 * numeric amount. Vouchers in this shape may still be sitting unclaimed on the
 * backend, and their senders are gone, so it is read forever and never written.
 */
interface LegacyGrinVoucher {
  blindingFactor?: unknown;
  commitment?: unknown;
  proof?: unknown;
  amount?: unknown;
  features?: unknown;
}

function requireHex(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Grin voucher field "${field}" is not a hex string`);
  }
  return value.toLowerCase();
}

/**
 * Parse an amount that may be a decimal string (GRINVCH1) or a number (legacy).
 *
 * A non-integer number is refused rather than truncated: it means the value
 * already lost precision somewhere upstream, and rounding it here would turn a
 * detectable problem into a voucher that fails to sweep for no visible reason.
 */
function parseAmount(value: unknown): bigint {
  if (typeof value === 'string') {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new Error(`Grin voucher amount "${value}" is not a decimal integer`);
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Grin voucher amount ${value} is not an exact positive integer`);
    }
    return BigInt(value);
  }
  throw new Error('Grin voucher has no amount');
}

/** Serialize a voucher as GRINVCH1 JSON bytes, ready to encrypt. */
export function encodeGrinVoucher(voucher: GrinVoucher): Uint8Array {
  if (voucher.amount <= 0n) {
    throw new Error('Grin voucher amount must be positive');
  }
  const body = {
    grinvch: GRIN_VOUCHER_VERSION,
    commit: requireHex(voucher.commit, 'commit'),
    proof: requireHex(voucher.proof, 'proof'),
    features: voucher.features,
    blind: requireHex(voucher.blind, 'blind'),
    amount: voucher.amount.toString(10),
  };
  return new TextEncoder().encode(JSON.stringify(body));
}

/**
 * Parse voucher bytes, accepting GRINVCH1 or the legacy untagged shape.
 *
 * Throws with a specific reason on anything malformed. A voucher that will not
 * parse is unspendable funds, so the reason has to be reportable rather than a
 * bare "invalid".
 */
export function decodeGrinVoucher(bytes: Uint8Array): GrinVoucher {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Error(`Grin voucher is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Grin voucher is not an object');
  }
  const o = raw as Record<string, unknown> & LegacyGrinVoucher;

  if (typeof o.grinvch === 'number') {
    if (o.grinvch !== GRIN_VOUCHER_VERSION) {
      throw new Error(
        `Grin voucher format version ${o.grinvch} is newer than this wallet understands`,
      );
    }
    return {
      commit: requireHex(o.commit, 'commit'),
      proof: requireHex(o.proof, 'proof'),
      features: typeof o.features === 'number' ? o.features : 0,
      blind: requireHex(o.blind, 'blind'),
      amount: parseAmount(o.amount),
    };
  }

  // Legacy: same content under the old names, amount as a JSON number.
  return {
    commit: requireHex(o.commitment, 'commitment'),
    proof: requireHex(o.proof, 'proof'),
    features: typeof o.features === 'number' ? o.features : 0,
    blind: requireHex(o.blindingFactor, 'blindingFactor'),
    amount: parseAmount(o.amount),
  };
}
