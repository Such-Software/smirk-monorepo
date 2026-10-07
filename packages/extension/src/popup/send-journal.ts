/**
 * Per-send record of the things only the SENDER can know.
 *
 * A blockchain does not tell you who you paid. For Bitcoin and Litecoin the
 * destination is at least recoverable from the transaction; for Monero and
 * Wownero it is not recorded anywhere on chain, and for a payment proof neither
 * is the transaction key. So the moment of signing is the only moment this
 * information exists, and the wallet was discarding it.
 *
 * WHAT IS STORED, AND WHY THIS SHAPE
 * ----------------------------------
 * `txKeyHex` is the transaction private key, exactly what `get_tx_key` reports
 * and what a payment proof is checked against. The signer derives it while the
 * spent outputs are still in hand and returns it only after checking it against
 * the public key the signed transaction published (see `verified_tx_key_hex` in
 * smirk-wasm), so a stored key is never one that would produce a false proof.
 * It is absent for subaddress destinations, where per-output keys apply.
 *
 * `outgoingViewKeyHex` is kept as well. It is the 32 bytes the tx key derives
 * from, but reproducing the key from it also needs the spent outputs' keys and
 * commitments, which the wallet does not keep; it stays for completeness and
 * for any later tool that can supply those.
 *
 * Both are fresh OS randomness per signature and deliberately NOT derived from
 * the seed: monero-oxide seeds its whole signing RNG from the outgoing view key,
 * so a deterministic value would repeat a CLSAG nonce across two signings of the
 * same inputs and leak the spent key.
 *
 * SECRET AT REST
 * --------------
 * The whole journal is one XChaCha20-Poly1305 ciphertext under a key derived
 * from the wallet's BTC private key with its own label (`send-journal`), bound
 * by AAD to the wallet fingerprint, so a copy moved to another wallet's slot
 * fails to decrypt rather than showing that wallet someone else's payments. The
 * tx key reveals who was paid and how much; the destinations and amounts do too.
 * None of it may sit in the browser profile in clear, and none of it is ever
 * sent to the backend.
 *
 * Journals written before encryption (the plaintext `{entries}` shape) are read
 * as-is and rewritten encrypted on the next write or keyed read.
 *
 * DISPLAY-ONLY, BEST-EFFORT
 * -------------------------
 * Like the Grin journal, nothing here gates spending. Every write is wrapped so
 * a journal failure can never block or fail a send: losing a receipt is bad,
 * failing a payment because a receipt could not be written is worse.
 */

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { encryptWithAad, decryptWithAad, bytesToHex, hexToBytes } from '@smirk/core';

/** chrome.storage.local slot. Bump the suffix on any breaking shape change. */
export const SEND_JOURNAL_KEY = 'smirk_send_journal_v1';

/** Label for the journal's key derivation. Distinct from the tip-key backup's
 *  `sha256(btcPrivateKey)`, so the two stores never share a key. */
const KEY_LABEL = new TextEncoder().encode('smirk:send-journal:v2');

/** One recorded outgoing payment, keyed by txid. */
export interface SendJournalEntry {
  /** On-chain transaction id (Grin: the kernel excess). */
  txid: string;
  /** `btc` | `ltc` | `xmr` | `wow` | `grin`. */
  asset: string;
  /** Where it was sent, exactly as the user entered it. */
  destination: string;
  /** Amount in atomic units, as a decimal string (u64 exceeds a JS number). */
  amountAtomic: string;
  /** Network fee in atomic units, as a decimal string. */
  feeAtomic?: string;
  /** XMR/WOW only. The verified transaction private key, hex. */
  txKeyHex?: string;
  /** XMR/WOW only. The per-signature `outgoing_view_key`, hex. */
  outgoingViewKeyHex?: string;
  /** Unix ms at which the send was signed. */
  createdAt: number;
  /**
   * Set when this send was a swap deposit: what the deposit was for, so the
   * history detail can show the swap and the status poll can find the
   * deposit's txid (THORChain tracks a swap by its inbound txid). Display
   * only, like everything else here.
   */
  swap?: SwapJournalFields;
}

export interface SwapJournalFields {
  /** `thorchain` | `trocador`. */
  provider: string;
  /** The wallet's id for the swap. */
  tradeId: string;
  /** Asset the swap pays out in. */
  toAsset: string;
  /** Payout address. */
  toAddress?: string;
  /** Quoted payout, in the destination asset's atomic units. */
  expectedToAtomic?: string;
  /** THORChain: the instruction the deposit carried. */
  memo?: string;
  /** Payout transaction once the provider reports it. */
  outboundTxid?: string;
  /** Last known state: `pending` | `completed` | `refunded` | `failed`. */
  state?: string;
}

/** The recorded swap deposit for a wallet swap id, if any. */
export async function findSwapDeposit(tradeId: string): Promise<SendJournalEntry | null> {
  try {
    const all = Object.values((await load()).entries);
    return all.find((e) => e.swap?.tradeId === tradeId) ?? null;
  } catch {
    return null;
  }
}

interface JournalPlain {
  entries: Record<string, SendJournalEntry>;
}

/** What sits in storage: ciphertext only. */
interface JournalSealed {
  v: 2;
  ct: string;
}

/**
 * The journal key for a wallet. Callers pass the unlocked wallet's BTC private
 * key; the key is derived on demand and never stored.
 */
export function sendJournalKey(btcPrivateKey: Uint8Array): Uint8Array {
  return hmac(sha256, btcPrivateKey, KEY_LABEL);
}

// Serialise writes so two concurrent sends cannot tear each other's
// read-modify-write apart. A lost update here is a missing receipt, never lost
// funds, but the mutex is cheap.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(op, op);
  chain = next.catch(() => undefined);
  return next;
}

/** Bound to a wallet, for the same reason the Grin journal is: this records who
 *  a PARTICULAR seed paid, and must never be shown to a different wallet. */
let scopeFingerprint: string | null = null;

/** Bind the journal to a wallet. Call on unlock, `null` on lock. */
export function setSendJournalScope(fingerprint: string | null): void {
  scopeFingerprint = fingerprint;
}

function scopedKey(fingerprint: string): string {
  return `${SEND_JOURNAL_KEY}:${fingerprint}`;
}

function aadFor(fingerprint: string): Uint8Array {
  return new TextEncoder().encode(`${SEND_JOURNAL_KEY}:${fingerprint}`);
}

function isSealed(raw: unknown): raw is JournalSealed {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw as JournalSealed).v === 2 &&
    typeof (raw as JournalSealed).ct === 'string'
  );
}

function isPlain(raw: unknown): raw is JournalPlain {
  return !!raw && typeof raw === 'object' && 'entries' in raw;
}

/**
 * Load and decrypt. A sealed journal that does not decrypt under `key` (wrong
 * wallet, corrupted) reads as empty, so a write will not merge into it; the
 * write path refuses to overwrite such a slot.
 */
async function load(
  fingerprint: string,
  key: Uint8Array,
): Promise<{ journal: JournalPlain; writable: boolean; wasPlain: boolean }> {
  const slot = scopedKey(fingerprint);
  const got = await chrome.storage.local.get(slot);
  const raw = got[slot];
  if (raw === undefined) return { journal: { entries: {} }, writable: true, wasPlain: false };
  if (isSealed(raw)) {
    try {
      const pt = decryptWithAad(hexToBytes(raw.ct), key, aadFor(fingerprint));
      const parsed = JSON.parse(new TextDecoder().decode(pt)) as unknown;
      if (isPlain(parsed)) return { journal: parsed, writable: true, wasPlain: false };
    } catch {
      // Fall through: unreadable under this key.
    }
    return { journal: { entries: {} }, writable: false, wasPlain: false };
  }
  if (isPlain(raw)) return { journal: raw, writable: true, wasPlain: true };
  return { journal: { entries: {} }, writable: true, wasPlain: false };
}

async function save(fingerprint: string, key: Uint8Array, j: JournalPlain): Promise<void> {
  const pt = new TextEncoder().encode(JSON.stringify(j));
  const sealed: JournalSealed = {
    v: 2,
    ct: bytesToHex(encryptWithAad(pt, key, aadFor(fingerprint))),
  };
  await chrome.storage.local.set({ [scopedKey(fingerprint)]: sealed });
}

/**
 * Record a send. Best-effort: never rejects, never throws.
 *
 * Merges onto an existing row so a later call cannot blank a field an earlier
 * one captured: the signing step knows the keys, the broadcast step knows the
 * confirmed txid, and neither should erase the other's work.
 */
export async function recordSend(entry: SendJournalEntry, key: Uint8Array): Promise<void> {
  try {
    await enqueue(async () => {
      const fp = scopeFingerprint;
      if (!fp) return;
      const { journal, writable } = await load(fp, key);
      if (!writable) return;
      const existing = journal.entries[entry.txid];
      journal.entries[entry.txid] = existing ? { ...existing, ...entry } : entry;
      await save(fp, key, journal);
    });
  } catch {
    // A receipt must never fail a payment.
  }
}

/**
 * Everything recorded for this wallet. Best-effort: `[]` on any failure.
 * Reading a pre-encryption journal rewrites it encrypted.
 */
export async function readSendJournal(key: Uint8Array): Promise<SendJournalEntry[]> {
  try {
    return await enqueue(async () => {
      const fp = scopeFingerprint;
      if (!fp) return [];
      const { journal, wasPlain } = await load(fp, key);
      if (wasPlain) await save(fp, key, journal);
      return Object.values(journal.entries);
    });
  } catch {
    return [];
  }
}

/** One recorded send, or `null` when this wallet never recorded that txid. */
export async function getSendRecord(
  txid: string,
  key: Uint8Array,
): Promise<SendJournalEntry | null> {
  const all = await readSendJournal(key);
  return all.find((e) => e.txid === txid) ?? null;
}

/** Drop a wallet's journal. Called when the user forgets that wallet. */
export async function clearSendJournal(fingerprint: string): Promise<void> {
  try {
    await chrome.storage.local.remove(scopedKey(fingerprint));
  } catch {
    // Best-effort: never block forgetting a wallet on a display store.
  }
}
