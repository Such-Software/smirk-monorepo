/**
 * Pure transaction-history mapping.
 *
 * Separated from the asset-detail route so the decisions that decide what a
 * user sees in Activity can be tested without dragging in chrome storage, wasm
 * or the network. Every function here is a pure function of its arguments;
 * the one that throws does so to report a failed read, never to hide one.
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
 * The chain tip an LWS history response reports, as the HEIGHT of the newest
 * block, or undefined when the response carries none.
 *
 * monero-lws fills `blockchain_height` with `get_last_block().id`, the height
 * of the newest block it holds (src/rpc/light_wallet.cpp and
 * src/rest_server.cpp), and smirk-backend-core passes it through unchanged. It
 * is not a block count, so there is nothing to subtract: a transaction mined in
 * that very block has one confirmation (`tip - height + 1`). Reading it as a
 * count put every XMR and WOW count one short and left a transaction in the
 * newest block at "Block #N" instead of "1 confirmation". `0` is what the
 * client substitutes when the backend omits the field, so it means unknown.
 */
export function lwsTipHeight(blockchainHeight: number | null | undefined): number | undefined {
  return typeof blockchainHeight === 'number' && Number.isFinite(blockchainHeight) && blockchainHeight > 0
    ? blockchainHeight
    : undefined;
}

/**
 * One Electrum UTXO history row as smirk-backend-core serializes it.
 *
 * Every optional field is `Option<u64>` on the server with no
 * `skip_serializing_if`, so "unknown" arrives as JSON `null`, not as a missing
 * key: every CONFIRMED row carries `"fee": null` (Electrum reports a fee only
 * for mempool rows), and `total_sent` is null whenever the server did not
 * resolve the inputs' prevouts. A missing key (older backends) means the same
 * thing. Test with `!= null`, never `!== undefined`: `BigInt(null)` throws, and
 * a null amount treated as known nets as 0.
 */
export interface UtxoHistoryWireRow {
  txid: string;
  height: number;
  fee?: number | null;
  total_received?: number | null;
  total_sent?: number | null;
  /** Block time, unix seconds or ISO, when the backend reports one. Electrum's
   *  `get_history` does not; a backend that resolves block headers can. */
  timestamp?: number | string | null;
}

/**
 * One transaction touching several of our addresses comes back once PER
 * ADDRESS, because the multi-address query concatenates per-address results.
 * A send that spends two of our inputs and pays our own change therefore
 * arrived three times and was listed three times. Collapse on txid, keeping
 * the first sighting and preferring any row that carries a fee.
 */
export function dedupeByTxid<T extends { txid: string; fee?: number | null }>(rows: T[]): T[] {
  const byTxid = new Map<string, T>();
  for (const t of rows) {
    const seen = byTxid.get(t.txid);
    if (!seen) byTxid.set(t.txid, t);
    else if (seen.fee == null && t.fee != null) byTxid.set(t.txid, t);
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
 * `total_received` / `total_sent` are OPTIONAL on the wire, and null or absent
 * whenever the backend could not determine them: Electrum's `get_history`
 * yields only txid, height and fee, and the backend fills amounts in best
 * effort. Defaulting them to `0` made every row a confident "sent 0", so the
 * amount is left undefined unless the backend actually reported both sides,
 * and direction is decided by the NET effect rather than by gross receipts (a
 * send with change credits us too, and used to be listed as an incoming
 * transfer).
 */
export function utxoTxToRow(t: UtxoHistoryWireRow): AssetDetailTxRow {
  const received = t.total_received ?? null;
  const sent = t.total_sent ?? null;
  // BOTH sides are required to net, and netting is the only way to tell a
  // receive from a send whose change came back to us. Electrum only reports the
  // spent side when the server resolved every input's prevout, which ours does
  // not, so a send would otherwise read as an incoming transfer of its own
  // change: the very bug this mapping exists to prevent. Knowing the credit
  // alone is not knowing the amount.
  const net = received !== null && sent !== null ? BigInt(received) - BigInt(sent) : null;
  // Without a net, direction is a best reading for the arrow only; the amount
  // stays unknown, and a send record (mergeSendJournal) overrides both. One
  // case is certain: a row in our history that paid us nothing touched us only
  // by spending from us.
  const direction: 'in' | 'out' =
    net !== null
      ? net >= 0n ? 'in' : 'out'
      : received === 0 || (received === null && (sent ?? 0) > 0)
        ? 'out'
        : 'in';
  const time = blockTimeIso(t.timestamp);
  return {
    kind: 'utxo',
    direction,
    ...(net !== null ? { amountAtomic: net >= 0n ? net : -net } : {}),
    txid: t.txid,
    heightOrPending: t.height > 0 ? t.height : 'pending',
    ...(t.fee != null ? { feeAtomic: BigInt(t.fee) } : {}),
    ...(time ? { timestamp: time } : {}),
  };
}

/**
 * A chain's history could not be read. Thrown rather than answered with `[]`,
 * because an empty list renders as "No activity yet", which tells a user with
 * funds that nothing ever happened; the coin screen shows this as an error
 * with a retry instead.
 */
export class HistoryUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'HistoryUnavailableError';
  }
}

/** The rows of a UTXO history response, newest first, one per transaction. A
 *  failed or empty-bodied response throws {@link HistoryUnavailableError}. */
export function utxoHistoryRows(r: {
  data?: { transactions: UtxoHistoryWireRow[] };
  error?: string;
}): AssetDetailTxRow[] {
  if (r.error || !r.data) {
    throw new HistoryUnavailableError(r.error || 'the server returned no history');
  }
  return sortUtxoTxs(dedupeByTxid(r.data.transactions)).map(utxoTxToRow);
}

/** A backend block time as ISO, or null when absent or unparseable. Numbers are
 *  unix SECONDS (what nodes report), not milliseconds. */
export function blockTimeIso(v: number | string | null | undefined): string | null {
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

type PendingOutgoingRow = Extract<AssetDetailTxRow, { kind: 'pending-outgoing' }>;
type ChainRow = Extract<AssetDetailTxRow, { kind: 'utxo' | 'cryptonote' }>;

/**
 * Put the wallet's in-flight sends in front of the chain's rows, one row per
 * transaction.
 *
 * A send exists twice while it is unconfirmed: as the in-flight entry this
 * wallet keeps until the network settles it (the `pending-outgoing` row) and,
 * once the backend sees it in the mempool, as a chain row. Listing both showed
 * one BTC or LTC payment twice in Activity, and a Monero or Wownero send the
 * same way once the LWS reported it. The chain row wins, because it is what
 * moves on to a block and a confirmation count, but it keeps what only the
 * in-flight entry knows, following the {@link mergeSendJournal} convention:
 *
 *   - the recipient and fee, when no send record supplied them (marked
 *     `fromInFlight`, since no send record was consulted for a key);
 *   - the amount and the outgoing direction, when the chain row cannot net
 *     the payment yet (no amount, or only the change visible, which reads as
 *     a receive of the change);
 *   - the broadcast time and fee, where the chain row has none;
 *   - what the payment was for (a swap deposit or a tip funding).
 *
 * An in-flight entry with no chain row stays as it is, at the top. Matching is
 * by txid, case-insensitively; rows of other kinds are untouched.
 */
export function mergePendingOutgoing(
  pending: PendingOutgoingRow[],
  history: AssetDetailTxRow[],
): AssetDetailTxRow[] {
  if (pending.length === 0) return history;
  const byTxid = new Map<string, PendingOutgoingRow>();
  for (const p of pending) if (p.txid) byTxid.set(p.txid.toLowerCase(), p);
  const absorbed = new Set<string>();
  const rows = history.map((row) => {
    if (row.kind !== 'utxo' && row.kind !== 'cryptonote') return row;
    const key = row.txid.toLowerCase();
    const p = byTxid.get(key);
    if (!p) return row;
    absorbed.add(key);
    return absorbInFlight(row, p);
  });
  const remaining = pending.filter((p) => !absorbed.has(p.txid.toLowerCase()));
  return [...remaining, ...rows];
}

function absorbInFlight(row: ChainRow, p: PendingOutgoingRow): ChainRow {
  const sent = row.sent ?? {
    destination: p.recipient,
    feeAtomic: p.feeAtomic,
    recordedAt: p.submittedAt,
    hasTxKey: false,
    fromInFlight: true as const,
  };
  const context = row.context ?? (p.context && p.context.kind !== 'send' ? p.context : undefined);
  // We broadcast this transaction, so it spent from us. A chain row that reads
  // it as a receive, or cannot say how much, has not seen that spend yet.
  const unnetted = row.amountAtomic === undefined || row.direction === 'in';
  const amountAndDirection = unnetted ? { direction: 'out' as const, amountAtomic: p.amountAtomic } : {};
  if (row.kind === 'cryptonote') {
    return { ...row, sent, ...amountAndDirection, ...(context ? { context } : {}) };
  }
  return {
    ...row,
    sent,
    ...amountAndDirection,
    ...(row.timestamp ? {} : { timestamp: p.submittedAt }),
    ...(row.feeAtomic === undefined ? { feeAtomic: p.feeAtomic } : {}),
    ...(context ? { context } : {}),
  };
}
