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
  /**
   * Owning receive/change address, in multi-address (fresh-address) mode.
   * Undefined in single-address mode (the whole listing is one address).
   */
  address?: string;
  /**
   * BIP84 master path of the owning address (`m/84'/coin'/0'/change/index`).
   * Money gate G9: this is CLIENT-sourced (from the wallet's own address book,
   * keyed by address), never derived from anything the server returns, so the
   * signer never has to re-guess which key owns a UTXO. Undefined in
   * single-address mode (the caller supplies the fixed `/0/0` path).
   */
  masterPath?: string;
}
export interface UtxoListing {
  asset: string;
  address: string;
  utxos: UtxoEntry[];
}

/**
 * An address the wallet owns, paired with its BIP84 master path. Passed to the
 * multi-address chain calls; the path is what lets the signer resolve the
 * owning key without re-deriving/guessing (money gate G9). Only the `address`
 * is ever sent to the server; the `masterPath` stays client-side and is
 * re-attached to each returned UTXO locally.
 */
export interface UtxoAddressRef {
  address: string;
  masterPath: string;
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
// Atomic amounts are STRINGS: XMR/WOW values can exceed 2^53, which a JS `number`
// cannot hold exactly, so the backend serializes them as decimal strings and every
// consumer BigInt-parses them. Never Number() an atomic amount. Heights, counts,
// and indices stay numbers (always well under 2^53).
export interface LwsSpentOutput {
  amount: string;
  key_image: string;
  tx_pub_key: string;
  out_index: number;
  /**
   * Subaddress index of the output BEING SPENT (`(0, 0)` = primary address),
   * read off the spend record itself, deliberately not the enclosing tx's
   * index, which is the change index.
   *
   * MONEY-CRITICAL on the balance path. The key image folds in the subaddress
   * secret, so a subaddress spend recomputed against the primary index never
   * matches, reads as a ring decoy, and is never subtracted: the wallet keeps
   * displaying money it has already spent. Optional because a legacy flat
   * backend omits it; `fetchAllBalances` fails closed rather than assuming
   * primary when it is absent and subaddress receive is in use.
   */
  subaddr_index?: LwsSubaddrIndex;
}
export interface LwsBalance {
  total_received: string;
  locked_balance: string;
  pending_balance: string;
  transaction_count: number;
  blockchain_height: number;
  start_height: number;
  scanned_height: number;
  spent_outputs: LwsSpentOutput[];
}
/**
 * The `(major, minor)` subaddress an output or tx was received at. `(0, 0)` is
 * the primary address. Nested to match the wasm `LwsOutput` shape, so the value
 * can be handed to the signer unchanged.
 */
export interface LwsSubaddrIndex {
  major: number;
  minor: number;
}
export interface LwsUnspentOutput {
  amount: string;
  public_key: string;
  tx_pub_key: string;
  index: number;
  global_index: number;
  height: number;
  rct: string;
  spend_key_images: string[];
  /**
   * Subaddress this output was received at. Optional: a legacy flat backend
   * omits it, and absent is read as the primary address.
   *
   * MONEY-CRITICAL on the spend path. A subaddress output's key image folds the
   * subaddress secret into the key offset, so spending it with the primary
   * index produces a key image the network rejects and the output is stranded.
   * The signer must thread this through verbatim, never re-derive or guess it.
   */
  subaddr_index?: LwsSubaddrIndex;
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
  total_received: string;
  spent_outputs: LwsSpentOutput[];
  payment_id?: string;
  /** Subaddress the receipt landed on. Display only; absent on legacy backends. */
  subaddr_index?: LwsSubaddrIndex;
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
/**
 * Result of asking the server to provision account-0 minor subaddress indices.
 *
 * `provisionedMinorMax` is the highest minor index the SERVER confirms is
 * provisioned, and is the only admissible source for the client's issuance
 * ceiling (money gate G4). It can legitimately come back lower than requested
 * (the LWS caps the batch at its own `--max-subaddresses`), which is precisely
 * why the client may not assume a ceiling from a local constant: handing out a
 * subaddress the LWS does not scan makes funds sent to it invisible.
 */
export interface LwsProvisionResult {
  provisionedMinorMax: number;
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
  /** Recovered derivation key id, populated only on the grin-lws path (the
   *  grin-wallet fallback leaves it null). When present and canonical it gives
   *  the spend path directly, so the client can skip the identify search. */
  key_id?: string | null;
  /** grin's `path[depth-1]`, NOT the spendable child index (that is `path[2]`
   *  in the depth-4 layout); kept for parity only. */
  n_child?: number | null;
  /** grin-lws maturity verdict; the client recomputes maturity itself, so this
   *  is diagnostic only. */
  spendable?: boolean | null;
}
export interface GrinScanResult {
  outputs: GrinScanOutput[];
  /** Backend's own sum; NOT trusted for `confirmed` (doesn't split maturity
   *  nor subtract pending-spent). Kept for parity/diagnostics only. */
  total_balance: number;
  /** Optional incremental-scan hint; correctness uses a full scan each call. */
  last_pmmr_index: number;
  /** grin-lws sync state; null on the grin-wallet fallback. Diagnostic only:
   *  the backend already gates trust on these server-side. */
  scanned_height?: number | null;
  blockchain_height?: number | null;
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
