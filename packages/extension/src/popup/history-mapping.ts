/**
 * Pure transaction-history mapping.
 *
 * Separated from the asset-detail route so the decisions that decide what a
 * user sees in Activity can be tested without dragging in chrome storage, wasm
 * or the network. Every function here is a total function of its arguments.
 */

import type { AssetDetailTxRow } from '@smirk/ui';

/**
 * Decide what a Cryptonote history row represents, given what we received in it
 * and what we have PROVEN we spent (key-image verified).
 *
 * `null` means the transaction is not ours: monero-lws also reports rows where
 * our only involvement is one of our outputs being sampled as somebody else's
 * ring decoy, and those must not appear in the user's activity at all.
 *
 * Otherwise the row is NETTED. monero-lws merges receives and spends into one
 * row per transaction, so a normal send carries its own change as
 * `total_received`; deciding direction from that alone reported every send as
 * an incoming transfer of the change.
 */
export function settleCryptonote(
  receivedAtomic: bigint,
  provenSpentAtomic: bigint,
): { direction: 'in' | 'out'; amountAtomic: bigint } | null {
  if (provenSpentAtomic === 0n && receivedAtomic === 0n) return null;
  const net = receivedAtomic - provenSpentAtomic;
  return net >= 0n
    ? { direction: 'in', amountAtomic: net }
    : { direction: 'out', amountAtomic: -net };
}

/**
 * One transaction touching several of our addresses comes back once PER
 * ADDRESS, because the multi-address query concatenates per-address results.
 * A send that spends two of our inputs and pays our own change therefore
 * arrived three times and was listed three times. Collapse on txid, keeping
 * the first sighting and preferring any row that carries a fee.
 */
export function dedupeByTxid<T extends { txid: string; fee?: number }>(rows: T[]): T[] {
  const byTxid = new Map<string, T>();
  for (const t of rows) {
    const seen = byTxid.get(t.txid);
    if (!seen) byTxid.set(t.txid, t);
    else if (seen.fee === undefined && t.fee !== undefined) byTxid.set(t.txid, t);
  }
  return [...byTxid.values()];
}

/** Newest first, with unconfirmed above everything. Electrum returns history in
 *  ascending height, so the list was reading oldest-first. Height `0` or below
 *  means unconfirmed, which belongs at the top rather than the bottom. */
export function sortUtxoTxs<T extends { height: number }>(txs: T[]): T[] {
  const rank = (t: T) => (t.height > 0 ? t.height : Number.MAX_SAFE_INTEGER);
  return [...txs].sort((a, b) => rank(b) - rank(a));
}

/**
 * Map an Electrum UTXO history row (single- or multi-address) to the UI row.
 *
 * `total_received` / `total_sent` are OPTIONAL on the wire and the namespaced
 * backend does not send them at all: Electrum's `get_history` yields only
 * txid, height and fee, and the backend passes that through. Defaulting them
 * to `0` made every row a confident "sent 0", so the amount is now left
 * undefined unless the backend actually reported it, and direction is decided
 * by the NET effect rather than by gross receipts (a send with change credits
 * us too, and used to be listed as an incoming transfer).
 */
export function utxoTxToRow(t: {
  txid: string;
  height: number;
  fee?: number;
  total_received?: number;
  total_sent?: number;
}): AssetDetailTxRow {
  const hasAmounts = t.total_received !== undefined || t.total_sent !== undefined;
  const net = BigInt(t.total_received ?? 0) - BigInt(t.total_sent ?? 0);
  return {
    kind: 'utxo',
    direction: net >= 0n ? 'in' : 'out',
    ...(hasAmounts ? { amountAtomic: net >= 0n ? net : -net } : {}),
    txid: t.txid,
    heightOrPending: t.height > 0 ? t.height : 'pending',
    ...(t.fee !== undefined ? { feeAtomic: BigInt(t.fee) } : {}),
  };
}
