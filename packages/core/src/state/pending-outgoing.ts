/**
 * pendingOutgoing: sender-side tracking of in-flight transactions.
 *
 * When a Send completes successfully, the wallet records the txHash +
 * amount + fee in session state. The displayed balance subtracts the
 * outgoing amount from `confirmed` until the entry is reconciled or
 * aged out, so a user who just sent doesn't see their full balance
 * sitting in `available` and try to send again.
 *
 * Reconciliation is evidence-first. XMR/WOW entries drop once their
 * key images verify as spent (`reconcilePendingOutgoing`). BTC/LTC
 * entries drop once the backend's history lists the tx as mined, or
 * once it has stopped listing the tx at all for an hour (dropped or
 * replaced; `reconcileUtxoPendingOutgoing`). The per-asset age-out
 * (WOW 5 min, XMR 30 min, Grin 60 min, BTC/LTC 24 h) is a backstop
 * for entries no evidence ever reaches, not the primary signal.
 *
 * Displayed available is clamped to ≥ 0, so any brief overlap between
 * the client-side pendingOutgoing subtraction and a spend the network
 * already reflects shows as 0 (correct under-display) rather than a
 * negative balance.
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
   * locked change preview": for CryptoNote/Mimblewimble chains the
   * displayed-available subtracts this whole sum (because the change
   * output will be locked, not immediately spendable), and the
   * difference (`inputsTotal − amount − fee`) appears as expected
   * locked change in the displayed-locked total until LWS reflects.
   * For UTXO chains the change is immediately spendable so this field
   * is informational only; display still subtracts amount + fee.
   *
   * Optional for forward compat with the timing-only v1 entries; old
   * entries fall back to the simpler `amount + fee` subtraction.
   */
  inputsTotal?: string;
  /**
   * Chain-appropriate identifiers for the inputs this tx spent. Used
   * for (a) input-selection filtering on subsequent sends in the same
   * pending window, keeps the send-handler from picking the same
   * UTXO / output twice before LWS/Electrum has reflected the spend
   * (the mempool-double-spend footgun), and (b) reconciliation:
   * when none of these identifiers remains in the spendable set, LWS
   * has caught up and this entry can be dropped early.
   *
   * Format per family:
   * - **CryptoNote (XMR/WOW)**: lowercase-hex computed key image, one
   *   per spent output.
   * - **UTXO (BTC/LTC)**: `${txid}:${vout}` pair, one per spent UTXO.
   * - **Mimblewimble (Grin)**: input commitment hex per input.
   *
   * Optional for forward compat with the timing-only v1 entries. The
   * older entries simply never appear in input exclusion / never
   * reconcile early; they age out normally.
   */
  inputs?: string[];
  /**
   * Why this tx was sent: drives the per-asset Activity row's copy
   * and tap-routing. Discriminated union so future categories (dapp
   * payments, v0.4 native swap deposits, etc.) drop in without
   * touching existing renderers.
   *
   * Optional + backward-compatible: pre-context entries render as
   * generic "Sending to {recipient}". Add a new variant in three
   * places: this union, the creating handler, and the Activity row
   * renderer. No migration on stored entries is needed because the
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
  | {
      kind: 'swap-deposit';
      tradeId: string;
      toAsset: string;
      provider: string;
      /** THORChain: the instruction the deposit must carry. */
      memo?: string;
      /** THORChain: the quoted deposit, in atomic units. A memo deposit of any
       *  other amount is refused rather than sent. */
      amountAtomic?: string;
      /** THORChain: Unix ms after which the deposit must not be sent. */
      depositBeforeMs?: number;
    };

/**
 * Per-asset age-out window (ms). After this duration, an entry is
 * pruned regardless of whether the scan caught up. The numbers
 * approximate the worst-case "scan has definitely caught up by now"
 * for each chain:
 *
 * - **WOW** ~2-min blocks, 4-conf cushion → 8 min on-chain + LWS rescan.
 *   5 min is short by ~30%, intentionally: the trade is "snap back to
 *   correct LWS state slightly early" vs "double-displayed balance
 *   sitting around indefinitely if scan never picks up". A user who
 *   sends and gets unlucky may see a brief flicker; cheaper than a
 *   stale ghost entry. Input-key-image reconciliation
 *   (`reconcilePendingOutgoing`) drops an entry as soon as the network
 *   reflects its inputs as spent, so this age-out only backstops
 *   entries that carry no `inputs`.
 * - **XMR** ~2-min blocks, 10-conf cushion → 20 min on-chain. 30 min
 *   gives the scanner room.
 * - **BTC/LTC** 24 h, a last resort only. A UTXO spend can sit in the
 *   mempool for hours when fees spike, and the backend's `confirmed`
 *   figure keeps counting its inputs until it is mined, so a time
 *   window short enough to feel tidy shows spent funds as available
 *   again (the v0.3.1 rc e2e run did exactly that at 60 min). These
 *   entries are reconciled against the backend's tx history instead
 *   (`reconcileUtxoPendingOutgoing`); the backstop only clears an
 *   entry whose history never arrives.
 * - **Grin** ~60 s blocks, but the lock-window cushion makes the
 *   relevant window 60 min. Revisit once we have spend telemetry
 *   from production.
 */
const AGE_OUT_MS_BY_ASSET: Record<string, number> = {
  wow: 5 * 60_000,
  xmr: 30 * 60_000,
  btc: 24 * 60 * 60_000,
  ltc: 24 * 60 * 60_000,
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
 * and (b) not aged out. Pure: caller decides whether to actually
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
 * Sum of outgoing amounts (recipient amount only; fee comes from the
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
    // also leaves the wallet, but for displayed-available math the
    // fee is part of `confirmed` reduction the network reflects, not
    // something we subtract here. We DO subtract fee for "outgoing
    // total" displayed to user (see pendingOutgoingTotalWithFee).
    total += BigInt(e.amount);
  }
  return total;
}

/**
 * Sum including fee: `amount + fee` per entry. Use for the "Sending
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
 * locked, not immediately spendable: i.e. *all* the inputs we spent
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
 * Expected locked change from non-stale entries: `inputsTotal − amount
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
 * spendable set before greedy selection: prevents picking an input
 * we just spent before LWS/Electrum has reflected it (the mempool
 * double-spend footgun).
 *
 * Comparisons are case-insensitive on the key-image side (LWS returns
 * lowercase hex; we lowercase on insert as well), so the caller can use
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
 * `verifiedSpent` set: i.e. the network (LWS / Electrum / etc.) now
 * reflects the spend. Comparison is by identifier in the same format
 * as `PendingOutgoingTx.inputs` (lowercase-hex key image for
 * CryptoNote, `txid:vout` for UTXO).
 *
 * Why "verified spent" rather than "still spendable": for XMR/WOW we
 * already compute the verified-spent set as part of balance fetch
 * (spend-key derived key images that match server-reported candidates),
 * so surfacing it costs nothing extra. The "still spendable" inverse
 * would require an additional unspent_outs fetch per refresh.
 *
 * Returns the kept entries. An entry without `inputs` (legacy v1
 * format) can't reconcile this way and falls back to timing age-out.
 *
 * Defense against double-counting: once LWS reflects the spend,
 * displayed-confirmed drops naturally. If we also subtracted
 * pendingOutgoing here the user
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
    // not in the set means "LWS hasn't fully reflected yet", so keep
    // the entry to keep the displayed-available subtraction live.
    const allVerifiedSpent = e.inputs.every((id) => verifiedSpent.has(id));
    return !allVerifiedSpent;
  });
}

/**
 * How long a BTC/LTC entry may go unlisted in the backend's history
 * before it is treated as dropped, replaced or never propagated. The
 * old timing-only window, so a broadcast the indexer is slow to pick
 * up is not released early.
 */
export const UTXO_UNLISTED_GRACE_MS = 60 * 60_000;

/** One row of a BTC/LTC address history: `height > 0` means mined. */
export interface UtxoTxStatus {
  txid: string;
  height: number;
}

/**
 * UTXO reconciliation against the backend's tx history for `asset`'s
 * addresses (an address's history lists the txs that spend from it,
 * mempool ones included at height 0 or below).
 *
 * - Listed as mined: dropped. `confirmed` now reflects the spend, and
 *   keeping the entry would subtract it twice.
 * - Listed as unconfirmed: kept, however old. `confirmed` still counts
 *   the inputs, so the entry is what keeps them out of available.
 * - Not listed for {@link UTXO_UNLISTED_GRACE_MS} after submit:
 *   dropped. The tx was evicted, replaced or never reached the
 *   network, and its inputs are spendable again.
 *
 * `history` null means the read failed or was not made: unknown, so
 * every entry is kept and only the age-out backstop applies.
 */
export function reconcileUtxoPendingOutgoing(
  entries: PendingOutgoingTx[],
  asset: string,
  history: readonly UtxoTxStatus[] | null,
  now: number,
): PendingOutgoingTx[] {
  if (!history) return entries;
  const heights = new Map<string, number>();
  for (const t of history) {
    const id = t.txid.toLowerCase();
    // The same tx can appear once per address; mined wins.
    heights.set(id, Math.max(heights.get(id) ?? t.height, t.height));
  }
  return entries.filter((e) => {
    if (e.asset !== asset) return true;
    const height = heights.get(e.txHash.toLowerCase());
    if (height === undefined) return now - e.submittedAt < UTXO_UNLISTED_GRACE_MS;
    return height <= 0;
  });
}

/**
 * Amount to take off a BTC/LTC `confirmed` balance for display: the
 * larger of what this wallet knows it has in flight (`amount + fee`
 * per live entry) and the mempool debit the backend reports, its
 * signed `unconfirmed` when negative (Electrum `get_balance`
 * semantics, see `sumBalances`).
 *
 * The larger, not the sum: once the backend sees a spend in the
 * mempool both figures describe the same coins. Taking the backend's
 * debit as a floor keeps a spend out of available even when its
 * entry is gone (made from another device, or past the backstop), and
 * covers a refresh where history already reports a tx mined but the
 * balance read predates it.
 */
export function utxoAvailableDeduction(
  entries: PendingOutgoingTx[],
  asset: string,
  backendUnconfirmed: bigint,
  now: number = Date.now(),
): bigint {
  const inFlight = pendingOutgoingTotalWithFee(entries, asset, now);
  const mempoolDebit = backendUnconfirmed < 0n ? -backendUnconfirmed : 0n;
  return inFlight > mempoolDebit ? inFlight : mempoolDebit;
}

/**
 * The reconcile a balance refresh runs before storing, as one pure
 * step: key-image reconciliation for every asset that reported
 * `verifiedSpentInputs`, history reconciliation for every UTXO asset
 * whose history was read, then the age-out backstop.
 */
export function reconcileAfterBalanceRefresh(
  entries: PendingOutgoingTx[],
  balances: Record<string, { verifiedSpentInputs?: string[] } | undefined>,
  utxoHistory: Partial<Record<string, readonly UtxoTxStatus[] | null>>,
  now: number,
): PendingOutgoingTx[] {
  let kept = entries;
  for (const [assetId, b] of Object.entries(balances)) {
    if (!b?.verifiedSpentInputs || b.verifiedSpentInputs.length === 0) continue;
    kept = reconcilePendingOutgoing(kept, assetId, new Set(b.verifiedSpentInputs));
  }
  for (const [assetId, history] of Object.entries(utxoHistory)) {
    kept = reconcileUtxoPendingOutgoing(kept, assetId, history ?? null, now);
  }
  return kept.filter((e) => !isStale(e, now));
}
