/**
 * pendingOutgoing — sender-side tracking of in-flight transactions.
 *
 * When a Send completes successfully, the wallet records the txHash +
 * amount + fee in session state. The displayed balance subtracts the
 * outgoing amount from `confirmed` until the entry is reconciled or
 * aged out, so a user who just sent doesn't see their full balance
 * sitting in `available` and try to send again.
 *
 * Reconciliation is timing-based in v1: entries age out per-asset
 * (WOW 5 min, XMR 30 min, BTC/LTC/Grin 60 min). The LWS / Electrum
 * scan picks up the spend within ~1-2 confs and the natural balance
 * fetch starts subtracting it through the verified-key-image / UTXO-
 * absent path. The age-out is a backstop, not the primary signal.
 *
 * Failure mode prevented: legacy commit 839e001 caused double-counting
 * when the client-side deduction stacked with backend's reflected
 * spend. We mitigate by clamping displayed available to ≥ 0 — any
 * brief overlap between "client subtracts pendingOutgoing" and
 * "LWS already reflects the spend" shows as 0 (correct under-display)
 * rather than negative.
 */

/**
 * One in-flight outgoing transaction. Stored in `SessionState.
 * pendingOutgoing` for the popup-close survival window. Atomic
 * amounts ship as strings (BigInt isn't JSON-safe) and reconstruct on
 * read.
 */
export interface PendingOutgoingTx {
  /** Asset id (`btc`, `ltc`, `xmr`, `wow`, `grin`). */
  asset: string;
  /** Network tx hash returned from the broadcast / submit. */
  txHash: string;
  /** Amount sent to recipient, atomic units, JSON-string of BigInt. */
  amount: string;
  /** Network fee paid, atomic units, JSON-string of BigInt. */
  fee: string;
  /** Recipient address (debug / receipts; never used for matching). */
  recipient: string;
  /** Unix ms when the wallet got an OK from broadcast/submit. */
  submittedAt: number;
  /**
   * Sum of the input atomic amounts this tx consumed. JSON-string of
   * BigInt. Set by the send-handler; load-bearing for the "post-send
   * locked change preview" — for CryptoNote/Mimblewimble chains the
   * displayed-available subtracts this whole sum (because the change
   * output will be locked, not immediately spendable), and the
   * difference (`inputsTotal − amount − fee`) appears as expected
   * locked change in the displayed-locked total until LWS reflects.
   * For UTXO chains the change is immediately spendable so this field
   * is informational only — display still subtracts amount + fee.
   *
   * Optional for forward compat with the timing-only v1 entries; old
   * entries fall back to the simpler `amount + fee` subtraction.
   */
  inputsTotal?: string;
  /**
   * Chain-appropriate identifiers for the inputs this tx spent. Used
   * for (a) input-selection filtering on subsequent sends in the same
   * pending window — keeps the send-handler from picking the same
   * UTXO / output twice before LWS/Electrum has reflected the spend
   * (the mempool-double-spend footgun), and (b) reconciliation —
   * when none of these identifiers remains in the spendable set, LWS
   * has caught up and this entry can be dropped early.
   *
   * Format per family:
   * - **CryptoNote (XMR/WOW)**: lowercase-hex computed key image, one
   *   per spent output.
   * - **UTXO (BTC/LTC)**: `${txid}:${vout}` pair, one per spent UTXO.
   * - **Mimblewimble (Grin)**: TBD when Grin send lands — likely the
   *   input commitment hex per input.
   *
   * Optional for forward compat with the timing-only v1 entries. The
   * older entries simply never appear in input exclusion / never
   * reconcile early; they age out normally.
   */
  inputs?: string[];
  /**
   * Why this tx was sent — drives the per-asset Activity row's copy
   * and tap-routing. Discriminated union so future categories (dapp
   * payments, v0.4 native swap deposits, etc.) drop in without
   * touching existing renderers.
   *
   * Optional + backward-compatible: pre-context entries render as
   * generic "Sending to {recipient}". Add a new variant in three
   * places: this union, the creating handler, and the Activity row
   * renderer — no migration on stored entries needed because the
   * field is optional.
   */
  context?: PendingOutgoingContext;
}

/**
 * Why a `pendingOutgoing` entry exists. Each variant carries just
 * enough context for the per-asset Activity row to render meaningful
 * copy and route to the right detail surface when tapped.
 */
export type PendingOutgoingContext =
  | { kind: 'send' }
  | { kind: 'tip-fund'; tipId: string }
  | { kind: 'swap-deposit'; tradeId: string; toAsset: string; provider: string };

/**
 * Per-asset age-out window (ms). After this duration, an entry is
 * pruned regardless of whether the scan caught up. The numbers
 * approximate the worst-case "scan has definitely caught up by now"
 * for each chain:
 *
 * - **WOW** ~2-min blocks, 4-conf cushion → 8 min on-chain + LWS rescan.
 *   5 min is short by ~30%, intentionally — the trade is "snap back to
 *   correct LWS state slightly early" vs "double-displayed balance
 *   sitting around indefinitely if scan never picks up". A user who
 *   sends and gets unlucky may see a brief flicker; cheaper than a
 *   stale ghost entry. Phase-2C will add input-key-image reconciliation
 *   so the age-out becomes a true backstop.
 * - **XMR** ~2-min blocks, 10-conf cushion → 20 min on-chain. 30 min
 *   gives the scanner room.
 * - **BTC/LTC** ~10 / ~2.5 min blocks, 1-conf shown as available →
 *   60 min covers worst case Electrum lag.
 * - **Grin** TBD; conservative 60 min until Grin send lands.
 */
const AGE_OUT_MS_BY_ASSET: Record<string, number> = {
  wow: 5 * 60_000,
  xmr: 30 * 60_000,
  btc: 60 * 60_000,
  ltc: 60 * 60_000,
  grin: 60 * 60_000,
};

const DEFAULT_AGE_OUT_MS = 30 * 60_000;

/** Is this entry past its age-out window? */
export function isStale(tx: PendingOutgoingTx, now: number): boolean {
  const window = AGE_OUT_MS_BY_ASSET[tx.asset] ?? DEFAULT_AGE_OUT_MS;
  return now - tx.submittedAt >= window;
}

/**
 * Filter a pendingOutgoing list to entries that are (a) for `asset`
 * and (b) not aged out. Pure — caller decides whether to actually
 * prune the underlying state.
 */
export function pendingOutgoingFor(
  entries: PendingOutgoingTx[],
  asset: string,
  now: number = Date.now(),
): PendingOutgoingTx[] {
  return entries.filter((e) => e.asset === asset && !isStale(e, now));
}

/**
 * Sum of outgoing amounts (recipient amount only — fee comes from the
 * input total separately, double-counting the fee here would oversub-
 * tract). Atomic units, BigInt.
 */
export function pendingOutgoingTotal(
  entries: PendingOutgoingTx[],
  asset: string,
  now: number = Date.now(),
): bigint {
  let total = 0n;
  for (const e of pendingOutgoingFor(entries, asset, now)) {
    // amount represents what left the wallet to the recipient. The fee
    // also leaves the wallet — but for displayed-available math the
    // fee is part of `confirmed` reduction the network reflects, not
    // something we subtract here. We DO subtract fee for "outgoing
    // total" displayed to user (see pendingOutgoingTotalWithFee).
    total += BigInt(e.amount);
  }
  return total;
}

/**
 * Sum including fee — `amount + fee` per entry. Use for the "Sending
 * X" subline. For UTXO chains this is also the right deduction from
 * displayed-available (change is immediately spendable). For
 * CryptoNote/Mimblewimble use `inFlightInputsTotal` instead.
 */
export function pendingOutgoingTotalWithFee(
  entries: PendingOutgoingTx[],
  asset: string,
  now: number = Date.now(),
): bigint {
  let total = 0n;
  for (const e of pendingOutgoingFor(entries, asset, now)) {
    total += BigInt(e.amount) + BigInt(e.fee);
  }
  return total;
}

/**
 * Sum of `inputsTotal` across non-stale entries for an asset. For
 * CryptoNote / Mimblewimble chains this is the right thing to
 * subtract from displayed-available because the change output will be
 * locked, not immediately spendable — i.e. *all* the inputs we spent
 * have effectively left the spendable set. Falls back to
 * `amount + fee` for old entries without `inputsTotal` (forward-compat
 * with v1 schema).
 */
export function inFlightInputsTotal(
  entries: PendingOutgoingTx[],
  asset: string,
  now: number = Date.now(),
): bigint {
  let total = 0n;
  for (const e of pendingOutgoingFor(entries, asset, now)) {
    if (e.inputsTotal !== undefined) {
      total += BigInt(e.inputsTotal);
    } else {
      total += BigInt(e.amount) + BigInt(e.fee);
    }
  }
  return total;
}

/**
 * Expected locked change from non-stale entries — `inputsTotal − amount
 * − fee`, summed across entries for an asset. For CryptoNote /
 * Mimblewimble chains this is what should appear in displayed-locked
 * during the in-flight window, until LWS reflects the spend and the
 * change output naturally appears with `locked > 0`. Returns 0 for
 * entries without `inputsTotal` (no preview possible).
 */
export function expectedLockedChange(
  entries: PendingOutgoingTx[],
  asset: string,
  now: number = Date.now(),
): bigint {
  let total = 0n;
  for (const e of pendingOutgoingFor(entries, asset, now)) {
    if (e.inputsTotal === undefined) continue;
    const change = BigInt(e.inputsTotal) - BigInt(e.amount) - BigInt(e.fee);
    if (change > 0n) total += change;
  }
  return total;
}

/**
 * Set of all input identifiers across non-stale `pendingOutgoing`
 * entries for one asset. The send-handler subtracts this from the
 * spendable set before greedy selection — prevents picking an input
 * we just spent before LWS/Electrum has reflected it (the mempool
 * double-spend footgun from legacy commits 15661ba / a007700).
 *
 * Comparisons are case-insensitive on the key-image side (LWS returns
 * lowercase hex; we lowercase on insert as well) — caller can use
 * `Set.has` directly without further normalization.
 */
export function recentlySpentInputs(
  entries: PendingOutgoingTx[],
  asset: string,
  now: number = Date.now(),
): Set<string> {
  const result = new Set<string>();
  for (const e of pendingOutgoingFor(entries, asset, now)) {
    if (!e.inputs) continue;
    for (const id of e.inputs) result.add(id);
  }
  return result;
}

/**
 * Reconciliation: drop entries whose every input is in the supplied
 * `verifiedSpent` set — i.e. the network (LWS / Electrum / etc.) now
 * reflects the spend. Comparison is by identifier in the same format
 * as `PendingOutgoingTx.inputs` (lowercase-hex key image for
 * CryptoNote, `txid:vout` for UTXO).
 *
 * Why "verified spent" rather than "still spendable": for XMR/WOW we
 * already compute the verified-spent set as part of balance fetch
 * (spend-key derived key images that match server-reported candidates)
 * — surfacing it costs nothing extra. The "still spendable" inverse
 * would require an additional unspent_outs fetch per refresh.
 *
 * Returns the kept entries. An entry without `inputs` (legacy v1
 * format) can't reconcile this way and falls back to timing age-out.
 *
 * Defense against double-counting (legacy commit `839e001`'s
 * scenario): once LWS reflects the spend, displayed-confirmed drops
 * naturally. If we also subtracted pendingOutgoing here the user
 * would see double-deduction (clamped to 0). Dropping the entry as
 * soon as we detect the spend keeps display = LWS state with no
 * artificial overlap window.
 */
export function reconcilePendingOutgoing(
  entries: PendingOutgoingTx[],
  asset: string,
  verifiedSpent: Set<string>,
): PendingOutgoingTx[] {
  return entries.filter((e) => {
    if (e.asset !== asset) return true; // not our concern
    if (!e.inputs || e.inputs.length === 0) return true; // can't reconcile, keep
    // Drop only when EVERY input is verified spent. A single input
    // not in the set means "LWS hasn't fully reflected yet" — keep
    // the entry to keep the displayed-available subtraction live.
    const allVerifiedSpent = e.inputs.every((id) => verifiedSpent.has(id));
    return !allVerifiedSpent;
  });
}
