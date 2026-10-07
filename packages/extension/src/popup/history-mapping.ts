/**
 * Pure transaction-history mapping.
 *
 * Separated from the asset-detail route so the decisions that decide what a
 * user sees in Activity can be tested without dragging in chrome storage, wasm
 * or the network. Every function here is a total function of its arguments.
 */

import type { AssetDetailTxRow } from '@smirk/ui';
import type { SendJournalEntry } from './send-journal';

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
  /** Block time, unix seconds or ISO, when the backend reports one. Electrum's
   *  `get_history` does not; a backend that resolves block headers can. */
  timestamp?: number | string;
}): AssetDetailTxRow {
  // BOTH sides are required to net, and netting is the only way to tell a
  // receive from a send whose change came back to us. Electrum only reports the
  // spent side when the server resolved every input's prevout, which ours does
  // not, so a send would otherwise read as an incoming transfer of its own
  // change: the very bug this mapping exists to prevent. Knowing the credit
  // alone is not knowing the amount.
  const canNet = t.total_received !== undefined && t.total_sent !== undefined;
  const net = BigInt(t.total_received ?? 0) - BigInt(t.total_sent ?? 0);
  return {
    kind: 'utxo',
    direction: net >= 0n ? 'in' : 'out',
    ...(canNet ? { amountAtomic: net >= 0n ? net : -net } : {}),
    txid: t.txid,
    heightOrPending: t.height > 0 ? t.height : 'pending',
    ...(t.fee !== undefined ? { feeAtomic: BigInt(t.fee) } : {}),
    ...(blockTimeIso(t.timestamp) ? { timestamp: blockTimeIso(t.timestamp) as string } : {}),
  };
}

/** A backend block time as ISO, or null when absent or unparseable. Numbers are
 *  unix SECONDS (what nodes report), not milliseconds. */
export function blockTimeIso(v: number | string | undefined): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return new Date(v * 1000).toISOString();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Lay what the wallet recorded at send time onto the chain's rows, by txid.
 *
 * The chain row stays authoritative for what it knows (height, netted amount);
 * the record adds what only the sender knew: who was paid, the fee, and when it
 * was signed. A BTC/LTC row the backend could not net (no amount) is one of our
 * own sends when the journal has it, so it takes the recorded direction and
 * amount instead of showing nothing. The transaction key is NOT copied onto the
 * row; the row only learns that one exists.
 */
export function mergeSendJournal(
  rows: AssetDetailTxRow[],
  entries: SendJournalEntry[],
): AssetDetailTxRow[] {
  if (entries.length === 0) return rows;
  const byTxid = new Map(entries.map((e) => [e.txid.toLowerCase(), e]));
  return rows.map((row) => {
    if (row.kind !== 'utxo' && row.kind !== 'cryptonote') return row;
    const e = byTxid.get(row.txid.toLowerCase());
    if (!e) return row;
    const recordedAt = new Date(e.createdAt).toISOString();
    const sent = {
      destination: e.destination,
      ...(e.feeAtomic !== undefined ? { feeAtomic: BigInt(e.feeAtomic) } : {}),
      recordedAt,
      hasTxKey: !!e.txKeyHex,
    };
    if (row.kind === 'cryptonote') return { ...row, sent };
    const unknownAmount = row.amountAtomic === undefined;
    return {
      ...row,
      sent,
      ...(unknownAmount ? { direction: 'out' as const, amountAtomic: BigInt(e.amountAtomic) } : {}),
      ...(row.timestamp ? {} : { timestamp: recordedAt }),
      ...(row.feeAtomic === undefined && e.feeAtomic !== undefined
        ? { feeAtomic: BigInt(e.feeAtomic) }
        : {}),
    };
  });
}
