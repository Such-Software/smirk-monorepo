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
 * `outgoingViewKey` rather than the transaction key itself. monero-oxide
 * derives the tx key from that plus the input keys (`TransactionKeys::new`), so
 * these 32 bytes reproduce the tx key AND the additional keys a subaddress send
 * uses, where storing one tx key would not. monero-core solves the same problem
 * by persisting `m_tx_keys[txid]` in its wallet cache, which is also why losing
 * that cache loses the ability to prove old payments.
 *
 * It is fresh OS randomness per signature and deliberately NOT derived from the
 * seed: monero-oxide seeds its whole signing RNG from it, so a deterministic
 * value would repeat a CLSAG nonce across two signings of the same inputs and
 * leak the spend key. That trade is the reason this file exists rather than a
 * derivation function.
 *
 * SECRET AT REST
 * --------------
 * `outgoingViewKey` is key material. It cannot move funds, but it reveals who
 * was paid and how much to anyone holding it, so it is encrypted with the same
 * wallet secret that protects the tip-key backups rather than written in clear.
 *
 * DISPLAY-ONLY, BEST-EFFORT
 * -------------------------
 * Like the Grin journal, nothing here gates spending. Every write is wrapped so
 * a journal failure can never block or fail a send: losing a receipt is bad,
 * failing a payment because a receipt could not be written is worse.
 */

/** chrome.storage.local slot. Bump the suffix on any breaking shape change. */
export const SEND_JOURNAL_KEY = 'smirk_send_journal_v1';

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
  /**
   * XMR/WOW only. Hex `outgoing_view_key` the signature used, from which the
   * transaction key is reproduced for a payment proof. Absent for chains that
   * need no such proof, and for sends made before this was recorded.
   */
  outgoingViewKeyHex?: string;
  /** Unix ms at which the send was signed. */
  createdAt: number;
}

interface SendJournal {
  entries: Record<string, SendJournalEntry>;
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

async function load(): Promise<SendJournal> {
  if (!scopeFingerprint) return { entries: {} };
  try {
    const key = scopedKey(scopeFingerprint);
    const got = await chrome.storage.local.get(key);
    const raw = got[key];
    if (raw && typeof raw === 'object' && 'entries' in raw) return raw as SendJournal;
  } catch {
    // chrome undefined (tests) or storage error: degrade to empty.
  }
  return { entries: {} };
}

async function save(j: SendJournal): Promise<void> {
  if (!scopeFingerprint) return;
  await chrome.storage.local.set({ [scopedKey(scopeFingerprint)]: j });
}

/**
 * Record a send. Best-effort: never rejects, never throws.
 *
 * Merges onto an existing row so a later call cannot blank a field an earlier
 * one captured: the signing step knows the view key, the broadcast step knows
 * the confirmed txid, and neither should erase the other's work.
 */
export async function recordSend(entry: SendJournalEntry): Promise<void> {
  try {
    await enqueue(async () => {
      const j = await load();
      const existing = j.entries[entry.txid];
      j.entries[entry.txid] = existing ? { ...existing, ...entry } : entry;
      await save(j);
    });
  } catch {
    // A receipt must never fail a payment.
  }
}

/** Everything recorded for this wallet. Best-effort: `[]` on any failure. */
export async function readSendJournal(): Promise<SendJournalEntry[]> {
  try {
    return Object.values((await load()).entries);
  } catch {
    return [];
  }
}

/** One recorded send, or `null` when this wallet never recorded that txid. */
export async function getSendRecord(txid: string): Promise<SendJournalEntry | null> {
  try {
    return (await load()).entries[txid] ?? null;
  } catch {
    return null;
  }
}

/** Drop a wallet's journal. Called when the user forgets that wallet. */
export async function clearSendJournal(fingerprint: string): Promise<void> {
  try {
    await chrome.storage.local.remove(scopedKey(fingerprint));
  } catch {
    // Best-effort: never block forgetting a wallet on a display store.
  }
}
