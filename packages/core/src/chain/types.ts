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
export interface GrinBalance {
  confirmed: number;
  locked: number;
  pending: number;
  total: number;
}
export interface GrinOutput {
  id: string;
  key_id: string;
  n_child: number;
  amount: number;
  commitment: string;
  is_coinbase: boolean;
  block_height: number | null;
  status: 'unconfirmed' | 'unspent' | 'locked' | 'spent';
}
export interface GrinOutputListing {
  outputs: GrinOutput[];
  /** Next BIP32 child index; load-bearing for deterministic key derivation. */
  next_child_index: number;
}
export interface GrinHistoryEntry {
  id: string;
  slate_id: string;
  amount: number;
  fee: number;
  direction: 'send' | 'receive';
  status: 'pending' | 'signed' | 'finalized' | 'confirmed' | 'cancelled';
  counterparty_user_id: string | null;
  created_at: string;
  kernel_excess: string | null;
}
export interface GrinHistory {
  transactions: GrinHistoryEntry[];
}
export interface GrinScanOutput {
  commit: string;
  block_height: number | null;
  mmr_index: number;
  proof: string | null;
}
export interface GrinScanResult {
  highest_index: number;
  last_retrieved_index: number;
  outputs: GrinScanOutput[];
}
export interface GrinBroadcastResult {
  success: boolean;
}
export interface GrinRecordResult {
  id: string;
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
