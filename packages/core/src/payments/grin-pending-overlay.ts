/**
 * GrinPendingOverlay: the MINIMAL client-only bridge between broadcasting a
 * Grin tx and the next `/wallet/grin/scan` that reflects it.
 *
 * Grin has no custodial output store: balance + spendable UTXOs come from
 * `POST /wallet/grin/scan` (the source of truth each call). But scan only sees
 * the CONFIRMED UTXO set, so between a broadcast and the block that mines it we
 * need a tiny local overlay to:
 *
 *   1. EXCLUDE just-spent inputs from selection (so a second send can't pick a
 *      UTXO whose spend is in-flight: a double-spend / "input already spent"
 *      reject), and
 *   2. SHOW unconfirmed change / incoming outputs as `pending` until scan
 *      confirms them.
 *
 * It is NOT an output store and NOT authoritative balance/spent bookkeeping:
 * every value is re-derived from scan; the overlay only carries the
 * confirmation-gap delta. Entries clear SCAN-DRIVEN (proof the spend confirmed),
 * with a 7-day age-out backstop mirroring the relay TTL so a stuck/cancelled tx
 * can never wedge input selection.
 *
 * It also owns `nextChildIndex`: the monotonic BIP32 change/receive counter.
 * With the server output store gone there is no `next_child_index` field; the
 * client MUST own it. Reusing an index re-derives an IDENTICAL commitment, which
 * makes the second output unspendable and silently loses funds, so the counter
 * is money-critical and lives here alongside the pending entries it protects.
 *
 * Pure over an injected {@link GrinPendingStore} (no `chrome.*` import) so
 * `@smirk/core` stays platform-agnostic: the extension wires a
 * chrome.storage.local adapter, tests inject a memory adapter.
 */

/** One in-flight tx, keyed by its broadcast slateId. */
export interface GrinPendingEntry {
  /** Input commitments this tx consumes: EXCLUDE from selection until mined. */
  spentCommits: string[];
  /** Unconfirmed change we produced (send side): shown as pending until scanned. */
  change?: { commit: string; value: number };
  /** Our new output (receive side): shown as pending until scanned. */
  incoming?: { commit: string; value: number };
  /**
   * True once the tx was actually broadcast (send flow: {@link processGrinS2}).
   * Entries created as a BUILD-TIME reservation (startGrinSend) start falsy, so a
   * pre-broadcast cancel may free their inputs; once broadcast, the inputs are
   * genuinely spent in-flight and must NOT be freed by a cancel (double-spend).
   */
  broadcast?: boolean;
  /** Unix seconds: for the age-out backstop. */
  broadcastAt: number;
}

export interface GrinPending {
  entries: Record<string /* slateId */, GrinPendingEntry>;
  /** Monotonic BIP32 change/receive child index. Never reused. */
  nextChildIndex: number;
}

/** Injected persistence. Extension → chrome.storage.local; tests → memory. */
export interface GrinPendingStore {
  load(): Promise<GrinPending>;
  save(p: GrinPending): Promise<void>;
  /**
   * Stable identity of the underlying storage slot (e.g. the chrome.storage
   * key). When present, ALL overlay instances built over stores that report the
   * SAME key share one process-global serialization lock, so two independently
   * constructed overlays over the same slot can't tear each other's
   * load-modify-save apart (lost update → child-index rewind = fund loss, or a
   * dropped broadcast flag = double-spend). Stores that back distinct in-memory
   * state (unique per test) may omit it or supply a unique key to opt out.
   */
  key?: string;
}

/** A scan output, reduced to the only field the overlay reads. */
export interface CommitLike {
  commit: string;
}

export const EMPTY_GRIN_PENDING: GrinPending = { entries: {}, nextChildIndex: 0 };

/** 7 days in seconds: mirrors the backend relay TTL. */
export const GRIN_PENDING_TTL_SECS = 7 * 24 * 60 * 60;

function clone(p: GrinPending): GrinPending {
  const entries: Record<string, GrinPendingEntry> = {};
  for (const [k, v] of Object.entries(p.entries)) {
    entries[k] = {
      spentCommits: [...v.spentCommits],
      ...(v.change ? { change: { ...v.change } } : {}),
      ...(v.incoming ? { incoming: { ...v.incoming } } : {}),
      ...(v.broadcast ? { broadcast: true } : {}),
      broadcastAt: v.broadcastAt,
    };
  }
  return { entries, nextChildIndex: p.nextChildIndex };
}

// ── Pure operations over GrinPending (overlay is derived, never authoritative) ──

/** Record a broadcast tx. Idempotent by slateId (a re-broadcast overwrites). */
export function addPendingEntry(
  p: GrinPending,
  slateId: string,
  fields: {
    spentCommits?: string[];
    change?: { commit: string; value: number };
    incoming?: { commit: string; value: number };
    broadcast?: boolean;
  },
  nowSecs: number,
): GrinPending {
  const next = clone(p);
  next.entries[slateId] = {
    spentCommits: fields.spentCommits ? [...fields.spentCommits] : [],
    ...(fields.change ? { change: { ...fields.change } } : {}),
    ...(fields.incoming ? { incoming: { ...fields.incoming } } : {}),
    ...(fields.broadcast ? { broadcast: true } : {}),
    broadcastAt: nowSecs,
  };
  return next;
}

/** Union of every entry's spent input commitments: the selection exclude set. */
export function selectablePendingSpentSet(p: GrinPending): Set<string> {
  const set = new Set<string>();
  for (const e of Object.values(p.entries)) {
    for (const c of e.spentCommits) set.add(c);
  }
  return set;
}

/**
 * Sum of unconfirmed change + incoming values whose commit is NOT yet present in
 * the scan output set. Feeds `AssetBalance.pending`. Once a commit appears in
 * scan it's counted by the confirmed/locked balance instead, so it drops out
 * here: no double counting.
 */
export function pendingChangeValue(p: GrinPending, scanOutputs: readonly CommitLike[]): number {
  const scanned = new Set(scanOutputs.map((o) => o.commit));
  let total = 0;
  for (const e of Object.values(p.entries)) {
    if (e.change && !scanned.has(e.change.commit)) total += e.change.value;
    if (e.incoming && !scanned.has(e.incoming.commit)) total += e.incoming.value;
  }
  return total;
}

/**
 * Clear entries scan proves settled, plus a hard age-out backstop.
 *
 * An entry is fully settled when NONE of its spent inputs still appear in the
 * scan UTXO set (inputs mined/gone) AND every output it produced (change /
 * incoming) now DOES appear (confirmed). A receive entry (no spentCommits, no
 * change) settles the moment its `incoming` commit is scanned. The 7-day
 * backstop drops stragglers (stuck / cancelled-but-not-cleared) so a wedged
 * entry can never permanently exclude its inputs from selection.
 */
export function reconcilePending(
  p: GrinPending,
  scanOutputs: readonly CommitLike[],
  nowSecs: number,
): GrinPending {
  const scanned = new Set(scanOutputs.map((o) => o.commit));
  const next = clone(p);
  for (const [slateId, e] of Object.entries(next.entries)) {
    const inputsGone = e.spentCommits.every((c) => !scanned.has(c));
    const changeConfirmed = !e.change || scanned.has(e.change.commit);
    const incomingConfirmed = !e.incoming || scanned.has(e.incoming.commit);
    const settled = inputsGone && changeConfirmed && incomingConfirmed;
    const aged = nowSecs - e.broadcastAt > GRIN_PENDING_TTL_SECS;
    if (settled || aged) delete next.entries[slateId];
  }
  return next;
}

/** Advance the child-index counter by one. Returns the new state. */
export function bumpNextChildIndexPure(p: GrinPending): GrinPending {
  const next = clone(p);
  next.nextChildIndex += 1;
  return next;
}

/**
 * Raise the counter to at least `candidate` (never lowers it). Seed = the max
 * identified `path[2]` across scan outputs + 1; guarded by max() so a partial
 * identify (or a stale scan) can never rewind the counter and cause reuse.
 */
export function seedNextChildIndexPure(p: GrinPending, candidate: number): GrinPending {
  if (!Number.isFinite(candidate) || candidate <= p.nextChildIndex) return p;
  const next = clone(p);
  next.nextChildIndex = candidate;
  return next;
}

// ── Stateful adapter wrapping the injected store ──────────────────────────────

/**
 * Process-global serialization chains, one per storage key. Any two overlay
 * instances built over stores that report the SAME {@link GrinPendingStore.key}
 * enqueue onto the same promise chain, so their load-modify-save operations are
 * strictly serialized even if the code constructed a fresh overlay instead of
 * sharing the singleton. This removes the "must share one instance" footgun by
 * construction: the mutex is per-storage-key, not per-instance. Stores with no
 * key fall back to a per-instance chain (see {@link GrinPendingOverlay.tail}).
 */
const GLOBAL_OVERLAY_LOCKS = new Map<string, Promise<unknown>>();

/**
 * Thin async wrapper that loads/mutates/persists the overlay through a
 * {@link GrinPendingStore}. All mutations save immediately (the overlay is tiny
 * and correctness beats a save-batching micro-optimization here).
 */
export class GrinPendingOverlay {
  constructor(private readonly store: GrinPendingStore) {}

  /**
   * Serializes every load-modify-save so a read and its dependent write can't be
   * torn apart by another op interleaving at an `await`. This is what makes
   * {@link reserveNextChildIndex} truly atomic (a plain load-then-save would let
   * two concurrent mint flows read the SAME index → duplicate commitment → fund
   * loss) and also keeps a concurrent index bump from clobbering an entry write
   * (or vice-versa). Read-only helpers (`load`, `selectablePendingSpent`,
   * `pendingChangeValue`, `nextChildIndex`) don't need it: `load` clones.
   *
   * The lock is keyed on the store's stable {@link GrinPendingStore.key} and
   * lives in {@link GLOBAL_OVERLAY_LOCKS}, so serialization holds ACROSS overlay
   * instances over the same storage slot, even if a code path constructs its own
   * overlay instead of sharing the singleton. Only when the store reports no key
   * (a unique in-memory store) does it fall back to this per-instance chain.
   */
  private tail: Promise<unknown> = Promise.resolve();

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const key = this.store.key;
    // Chain after whatever is currently queued for this storage key (across all
    // instances); or, keyless, after this instance's own tail. Run `op` whether
    // the predecessor settled or rejected, so one failed op never wedges the
    // queue.
    const prev =
      key !== undefined ? GLOBAL_OVERLAY_LOCKS.get(key) ?? Promise.resolve() : this.tail;
    const result = prev.then(op, op);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    if (key !== undefined) {
      GLOBAL_OVERLAY_LOCKS.set(key, settled);
    } else {
      this.tail = settled;
    }
    return result;
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  load(): Promise<GrinPending> {
    return this.store.load();
  }

  /** Record a broadcast tx (send: spentCommits + change; receive: incoming). */
  async addPending(
    slateId: string,
    fields: {
      spentCommits?: string[];
      change?: { commit: string; value: number };
      incoming?: { commit: string; value: number };
      broadcast?: boolean;
    },
  ): Promise<void> {
    await this.enqueue(async () => {
      const p = await this.store.load();
      await this.store.save(addPendingEntry(p, slateId, fields, this.now()));
    });
  }

  /**
   * Drop a single PRE-BROADCAST entry (explicit user cancel: its reserved inputs
   * become selectable again). Fail-safe: an entry flagged `broadcast` is NEVER
   * removed here: its inputs are genuinely spent in-flight and freeing them would
   * let a later send re-select them and build a double-spend. A broadcast entry
   * only ever retires scan-driven (reconcile) or via the 7-day backstop.
   */
  async remove(slateId: string): Promise<void> {
    await this.enqueue(async () => {
      const p = await this.store.load();
      const entry = p.entries[slateId];
      if (!entry || entry.broadcast) return;
      const next = clone(p);
      delete next.entries[slateId];
      await this.store.save(next);
    });
  }

  /** The selection exclude set (just-spent, not yet mined). */
  async selectablePendingSpent(): Promise<Set<string>> {
    return selectablePendingSpentSet(await this.store.load());
  }

  /** Unconfirmed change/incoming value → AssetBalance.pending. */
  async pendingChangeValue(scanOutputs: readonly CommitLike[]): Promise<number> {
    return pendingChangeValue(await this.store.load(), scanOutputs);
  }

  /** Reconcile against a fresh scan and persist. Call at the start of every fetch. */
  async reconcile(scanOutputs: readonly CommitLike[]): Promise<void> {
    await this.enqueue(async () => {
      const p = await this.store.load();
      const next = reconcilePending(p, scanOutputs, this.now());
      await this.store.save(next);
    });
  }

  /** Current next-available child index (does NOT advance). */
  async nextChildIndex(): Promise<number> {
    return (await this.store.load()).nextChildIndex;
  }

  /**
   * ATOMICALLY reserve the next child index: read the current counter, persist
   * counter+1, and return the reserved value, all inside the serialization mutex
   * so two concurrent mint flows can never be handed the same index. This is the
   * money-critical allocation primitive: every flow that mints a new output MUST
   * derive its path from a value returned here (not from a read-now / bump-later
   * pair, which races). A reserved index that ends up unused (e.g. a send that
   * produced no change, or a build that failed) is simply skipped: harmless,
   * since the counter only ever moves forward and never re-hands a value.
   */
  reserveNextChildIndex(): Promise<number> {
    return this.enqueue(async () => {
      const p = await this.store.load();
      const reserved = p.nextChildIndex;
      await this.store.save(bumpNextChildIndexPure(p));
      return reserved;
    });
  }

  /** Advance the counter by one (after creating an output at the current index). */
  async bumpNextChildIndex(): Promise<void> {
    await this.enqueue(async () => {
      const p = await this.store.load();
      await this.store.save(bumpNextChildIndexPure(p));
    });
  }

  /** Raise the counter to at least `candidate` (seed = max identified path[2] + 1). */
  async seedNextChildIndex(candidate: number): Promise<void> {
    await this.enqueue(async () => {
      const p = await this.store.load();
      const next = seedNextChildIndexPure(p, candidate);
      if (next !== p) await this.store.save(next);
    });
  }
}

/**
 * In-memory store: the test/default adapter.
 *
 * Pass `key` to opt this store into the process-global per-key serialization
 * lock (see {@link GrinPendingStore.key}). Two overlays built over the SAME
 * store object already share state; giving them the SAME key makes their
 * load-modify-save serialize across instances too, which is what the
 * multi-instance interleaving test exercises. Omit `key` (the default) for
 * ordinary single-overlay tests so each store stays isolated.
 */
export function createMemoryGrinPendingStore(
  initial: GrinPending = EMPTY_GRIN_PENDING,
  key?: string,
): GrinPendingStore {
  let state = clone(initial);
  return {
    ...(key !== undefined ? { key } : {}),
    load: () => Promise.resolve(clone(state)),
    save: (p) => {
      state = clone(p);
      return Promise.resolve();
    },
  };
}
