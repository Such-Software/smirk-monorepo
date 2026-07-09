/**
 * Grin client-side tx-history journal — an append-only, best-effort record of
 * this wallet's Grin send/receive/tip activity, keyed by slateId in
 * `chrome.storage.local` under `grin_tx_journal_v1`.
 *
 * WHY THIS EXISTS
 * ---------------
 * v3 Grin is NON-CUSTODIAL. `POST /wallet/grin/scan` exposes only the wallet's
 * CURRENT UTXO set — never a send/receive log — and Mimblewimble commitments
 * carry no amount/direction a third party (or a later scan) could reconstruct.
 * So asset-detail's Grin Activity went dark (returned `[]`). This module
 * restores that history the only way possible client-side: by capturing each
 * money flow's metadata at the exact moment we still have it in hand (send
 * build, send finalize/broadcast, receive sign, invoice finalize, tip build),
 * then replaying it into asset-detail.
 *
 * READ-ONLY DISPLAY — NEVER MONEY-CRITICAL
 * ----------------------------------------
 * Unlike {@link GrinPendingOverlay} (which gates input selection + owns the
 * child-index counter, and whose corruption loses funds), this journal is PURE
 * DISPLAY. It never gates spending, never influences selection, never touches
 * balance. Therefore every write here is BEST-EFFORT: a journal failure must
 * never block, delay, or error a money flow. Callers wrap invocations in
 * `.catch()`, and every function here additionally swallows its own storage
 * errors (including a `chrome` that is undefined under test) and can never
 * reject.
 *
 * CONCURRENCY
 * -----------
 * Mirrors the overlay's chrome-store + process-global mutex style: all
 * load-modify-save mutations run through a single module-level serialization
 * chain ({@link enqueue}) so two concurrent writes over the one storage slot
 * can't tear each other's read-modify-write apart (a lost update here is only a
 * missing/stale history row, never fund loss — but the mutex is cheap and keeps
 * the append-only invariant honest).
 */

/** chrome.storage.local slot. Bump the suffix on any breaking shape change. */
export const GRIN_TX_JOURNAL_KEY = 'grin_tx_journal_v1';

/** Which side of the ledger a journal entry sits on. */
export type GrinTxDirection = 'send' | 'receive';

/**
 * Lifecycle of a journalled tx. Deliberately coarse (display-only):
 *   - `pending`   — built/signed locally, not yet known-broadcast.
 *   - `finalized` — we (or our counterparty) put it on the wire; `kernelExcess`
 *                   is usually known and links to a block explorer.
 *   - `cancelled` — the user abandoned a still-pre-broadcast flow.
 */
export type GrinTxStatus = 'pending' | 'finalized' | 'cancelled';

/** One journalled Grin tx, keyed by its slateId. */
export interface GrinTxJournalEntry {
  /** Slate UUID (or voucher pseudo-slate id) — the primary key. */
  slateId: string;
  direction: GrinTxDirection;
  /** Amount moved, in nanogrin (atomic units). */
  amountNanogrin: number;
  /** Network fee in nanogrin, when known. */
  fee?: number;
  /** Counterparty label (slatepack address, @username, user_id) when known. */
  counterparty?: string;
  status: GrinTxStatus;
  /** On-chain kernel excess — the block-explorer identity — once finalized. */
  kernelExcess?: string;
  /** Unix ms of first record (stable across status updates). */
  createdAt: number;
}

/** Persisted shape: a slateId → entry map (append-only; entries never deleted). */
interface GrinTxJournal {
  entries: Record<string, GrinTxJournalEntry>;
}

// ── Process-global serialization (one chain for the single storage slot) ──────

let tail: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  // Run `op` after whatever is queued, whether the predecessor settled or
  // rejected, so one failed write never wedges the chain.
  const result = tail.then(op, op);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// ── Storage adapter (best-effort; tolerates a missing `chrome`) ───────────────

async function loadJournal(): Promise<GrinTxJournal> {
  try {
    const got = await chrome.storage.local.get(GRIN_TX_JOURNAL_KEY);
    const raw = got[GRIN_TX_JOURNAL_KEY];
    if (raw && typeof raw === 'object' && 'entries' in raw) {
      return raw as GrinTxJournal;
    }
  } catch {
    // chrome undefined (tests) or storage error — degrade to empty.
  }
  return { entries: {} };
}

async function saveJournal(j: GrinTxJournal): Promise<void> {
  await chrome.storage.local.set({ [GRIN_TX_JOURNAL_KEY]: j });
}

// ── Public API — every function is best-effort and can never reject ───────────

/**
 * Record (or enrich) a journal entry. Upsert semantics keyed by `slateId`:
 *
 *   - First write for a slateId inserts the entry as-is.
 *   - A later write for the SAME slateId MERGES: it preserves the original
 *     `createdAt` and `direction`, and fills in / overrides `status`,
 *     `kernelExcess`, `fee`, and `counterparty` from whatever the newer call
 *     knows. `amountNanogrin` is preserved from the original when the newer
 *     call passes a falsy (0) amount, so a finalize step that doesn't re-derive
 *     the amount can't clobber the real value recorded at build time.
 *
 * This lets the two-phase flows (build → finalize) collapse onto one row: the
 * build records `pending` + amount, the finalize upgrades it to `finalized` +
 * kernelExcess. Best-effort — swallows all errors.
 */
export async function recordGrinTx(entry: GrinTxJournalEntry): Promise<void> {
  try {
    await enqueue(async () => {
      const j = await loadJournal();
      const existing = j.entries[entry.slateId];
      j.entries[entry.slateId] = existing
        ? {
            ...existing,
            // createdAt + direction are anchored by the FIRST write.
            status: entry.status,
            amountNanogrin: entry.amountNanogrin || existing.amountNanogrin,
            ...(entry.fee !== undefined ? { fee: entry.fee } : {}),
            ...(entry.counterparty !== undefined
              ? { counterparty: entry.counterparty }
              : {}),
            ...(entry.kernelExcess !== undefined
              ? { kernelExcess: entry.kernelExcess }
              : {}),
          }
        : { ...entry };
      await saveJournal(j);
    });
  } catch (e) {
    console.warn('[grin-journal] record failed (non-fatal, display-only):', e);
  }
}

/**
 * Flip an existing entry's status (e.g. → `cancelled` on user cancel). No-op if
 * the slateId was never journalled. Best-effort — swallows all errors.
 */
export async function updateGrinTxStatus(
  slateId: string,
  status: GrinTxStatus,
): Promise<void> {
  try {
    await enqueue(async () => {
      const j = await loadJournal();
      const existing = j.entries[slateId];
      if (!existing) return;
      j.entries[slateId] = { ...existing, status };
      await saveJournal(j);
    });
  } catch (e) {
    console.warn('[grin-journal] status update failed (non-fatal):', e);
  }
}

/**
 * Read the whole journal as a flat array (unordered — caller sorts). Best-effort:
 * returns `[]` on any error so asset-detail never throws off a bad journal.
 */
export async function readGrinJournal(): Promise<GrinTxJournalEntry[]> {
  try {
    const j = await loadJournal();
    return Object.values(j.entries);
  } catch {
    return [];
  }
}
