/**
 * Backend-agnostic chain-data contract types.
 *
 * These describe the SHAPE of chain data, independent of who serves it. The
 * default `SmirkBackend*` providers delegate to the `api.*` methods whose inline
 * return shapes are structurally identical to these; a future direct provider
 * (electrum, monero-lws, grin-lws) targets the same types. Keeping them named
 * and separate is what lets the data source be swapped without touching callers.
 *
 * NOTE: shapes are intentionally chain-specific (UTXO vs ring-CT vs Pedersen
 * commitment). We do not collapse them into one "unified" balance/output type:
 * load-bearing fields (lws `spent_outputs` / `fee_mask`, grin `next_child_index`)
 * would be lost in a merge.
 */

// ---- UTXO chains (btc, ltc) ----
export interface UtxoBalance {
  asset: string;
  address: string;
  confirmed: number;
  unconfirmed: number;
  total: number;
}
export interface UtxoEntry {
  txid: string;
  vout: number;
  value: number;
  height: number;
}
export interface UtxoListing {
  asset: string;
  address: string;
  utxos: UtxoEntry[];
}
export interface UtxoBroadcastResult {
  asset: string;
  txid: string;
}
export interface UtxoHistoryEntry {
  txid: string;
  height: number;
  fee?: number;
  total_received?: number;
  total_sent?: number;
}
export interface UtxoHistory {
  asset: string;
  address: string;
  transactions: UtxoHistoryEntry[];
}

// ---- Ring-CT light-wallet-server chains (xmr, wow) ----
export interface LwsSpentOutput {
  amount: number;
  key_image: string;
  tx_pub_key: string;
  out_index: number;
}
export interface LwsBalance {
  total_received: number;
  locked_balance: number;
  pending_balance: number;
  transaction_count: number;
  blockchain_height: number;
  start_height: number;
  scanned_height: number;
  spent_outputs: LwsSpentOutput[];
}
export interface LwsUnspentOutput {
  amount: number;
  public_key: string;
  tx_pub_key: string;
  index: number;
  global_index: number;
  height: number;
  rct: string;
  spend_key_images: string[];
}
export interface LwsUnspent {
  outputs: LwsUnspentOutput[];
  /** Per-byte fee; the ring-CT fee is derived from this, not a separate endpoint. */
  per_byte_fee: number;
  fee_mask: number;
}
export interface LwsRandomOutput {
  global_index: number;
  public_key: string;
  rct: string;
}
export interface LwsRandomOuts {
  outputs: LwsRandomOutput[];
}
export interface LwsSubmitResult {
  success: boolean;
  status: string;
}
export interface LwsHistoryEntry {
  txid: string;
  height: number;
  timestamp: string;
  is_pending: boolean;
  total_received: number;
  spent_outputs: LwsSpentOutput[];
  payment_id?: string;
}
export interface LwsHistory {
  asset: string;
  transactions: LwsHistoryEntry[];
  scanned_height: number;
  blockchain_height: number;
}
export interface LwsRegisterResult {
  success: boolean;
  message: string;
  start_height?: number;
}
export interface LwsDeactivateResult {
  success: boolean;
  message: string;
}

// ---- Mimblewimble (grin) ----
//
// Grin is NON-CUSTODIAL: there is no server-side output store, balance, or
// history. `POST /wallet/grin/scan` rewinds the UTXO set with the wallet's
// view-only `rewind_hash` and returns its currently-unspent outputs — the
// single source of truth for balance and spendable inputs. The client owns
// output state; balance/maturity/pending are derived from scan + a minimal
// local pending overlay (see payments/grin-pending-overlay.ts).
export interface GrinScanOutput {
  /** 33-byte Pedersen commitment, lowercase hex. Stable output identifier. */
  commit: string;
  /** Value in nanogrin. */
  value: number;
  /** Block height the output was mined at (0 if not yet confirmed). */
  height: number;
  /** MMR position; only an incremental-scan hint, not used for correctness. */
  mmr_index: number;
  is_coinbase: boolean;
  /** Kernel lock height; the output is unspendable until tip >= lock_height. */
  lock_height: number;
}
export interface GrinScanResult {
  outputs: GrinScanOutput[];
  /** Backend's own sum; NOT trusted for `confirmed` (doesn't split maturity
   *  nor subtract pending-spent). Kept for parity/diagnostics only. */
  total_balance: number;
  /** Optional incremental-scan hint; correctness uses a full scan each call. */
  last_pmmr_index: number;
}
export interface GrinBroadcastResult {
  success: boolean;
}

// ---- Fee model ----
//
// Every chain has a fee (except genuinely feeless ones). What differs is where
// the number comes from; `feeModel` (in ChainCapabilities) declares that, and
// `estimateFee()` returns the matching variant. No chain is "unsupported".
export type FeeModel =
  | 'rate-estimate' // utxo: live per-byte rate from mempool; show fast/normal/slow
  | 'param-derived' // ring-CT: per_byte_fee/fee_mask travel with listOutputs
  | 'formula' //       grin: fee = baseFee * tx weight, computed client-side
  | 'gas' //           evm: baseFee + priority tip
  | 'feeless'; //      nano/xno

export type FeeEstimate =
  | { model: 'rate-estimate'; fast: number | null; normal: number | null; slow: number | null }
  | { model: 'param-derived' } // values are on the listOutputs response (per_byte_fee/fee_mask)
  | { model: 'formula'; baseFee?: number }
  | { model: 'gas'; baseFee: number; priorityTip: number }
  | { model: 'feeless' };
