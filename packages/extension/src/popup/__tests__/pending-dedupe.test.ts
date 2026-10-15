/**
 * One payment, one Activity row.
 *
 * An unconfirmed send exists twice: as the in-flight entry the wallet keeps
 * until the network settles it, and, once the backend sees it in the mempool,
 * as a chain row. The coin screen listed both, so with UTXO chain history
 * rendering, every unconfirmed BTC or LTC send appeared twice (and an XMR or
 * WOW send the same way once the LWS reported it). The chain row now stands
 * for the payment and keeps what only the in-flight entry knew.
 *
 * Properties, not fixtures: no wording or list length beyond "one per txid".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTxDetail, type AssetDetailTxRow } from '@smirk/ui';

import {
  mergePendingOutgoing,
  mergeSendJournal,
  utxoHistoryRows,
  type UtxoHistoryWireRow,
} from '../history-mapping';
import type { SendJournalEntry } from '../send-journal';

type Pending = Extract<AssetDetailTxRow, { kind: 'pending-outgoing' }>;

const TXID = 'f65c'.repeat(16);
const SUBMITTED = '2026-10-15T09:00:00.000Z';

const pending = (txid: string, extra: Partial<Pending> = {}): Pending => ({
  kind: 'pending-outgoing',
  txid,
  amountAtomic: 4000n,
  feeAtomic: 154n,
  recipient: 'bc1qbob',
  submittedAt: SUBMITTED,
  ...extra,
});

/** Alice's BTC history as the backend relays it: her send, still in the mempool. */
function aliceHistory(fields: string): AssetDetailTxRow[] {
  return utxoHistoryRows({
    data: JSON.parse(`{"transactions":[
      {"txid":"${TXID}","height":0,${fields}},
      {"txid":"${'0a'.repeat(32)}","height":866100,"fee":null,"total_received":9874,"total_sent":0}
    ]}`) as { transactions: UtxoHistoryWireRow[] },
  });
}

const rowsFor = (rows: AssetDetailTxRow[], txid: string) =>
  rows.filter((r) => 'txid' in r && r.txid.toLowerCase() === txid.toLowerCase());

test('an unconfirmed BTC send the chain already lists appears once, as the chain row', () => {
  const rows = mergePendingOutgoing(
    [pending(TXID)],
    aliceHistory('"fee":154,"total_received":5846,"total_sent":10000'),
  );
  const mine = rowsFor(rows, TXID);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.kind, 'utxo');
  // Every other row survives.
  assert.equal(rows.length, 2);
});

test('txids match whatever their case', () => {
  const rows = mergePendingOutgoing(
    [pending(TXID.toUpperCase())],
    aliceHistory('"fee":154,"total_received":5846,"total_sent":10000'),
  );
  assert.equal(rowsFor(rows, TXID).length, 1);
});

test('a send the chain does not list yet stays, at the top', () => {
  const other = 'cc'.repeat(32);
  const rows = mergePendingOutgoing([pending(other)], aliceHistory('"fee":154,"total_received":5846,"total_sent":10000'));
  assert.equal(rows[0]?.kind, 'pending-outgoing');
  assert.equal(rowsFor(rows, other).length, 1);
});

test('the netted chain amount stays authoritative', () => {
  const [row] = rowsFor(
    mergePendingOutgoing([pending(TXID)], aliceHistory('"fee":154,"total_received":5846,"total_sent":10000')),
    TXID,
  );
  assert.ok(row && row.kind === 'utxo');
  assert.equal(row.direction, 'out');
  assert.equal(row.amountAtomic, 4154n);
});

test('a chain row that cannot net the send takes the known amount, recipient and time', () => {
  // No prevouts resolved: the chain row has only the change, so no amount.
  const [row] = rowsFor(
    mergePendingOutgoing([pending(TXID)], aliceHistory('"fee":null,"total_received":5846,"total_sent":null')),
    TXID,
  );
  assert.ok(row && row.kind === 'utxo');
  assert.equal(row.direction, 'out');
  assert.equal(row.amountAtomic, 4000n);
  assert.equal(row.feeAtomic, 154n);
  assert.equal(row.timestamp, SUBMITTED);
  assert.equal(row.sent?.destination, 'bc1qbob');
  const detail = buildTxDetail(row, 'btc', { explorerAvailable: true });
  assert.equal(detail.fields.find((f) => f.label === 'Sent to')?.value, 'bc1qbob');
  assert.equal(detail.fields.find((f) => f.label === 'Status')?.value, 'Unconfirmed (in mempool)');
});

test('a send record already on the chain row is kept over the in-flight entry', () => {
  const journal: SendJournalEntry = {
    txid: TXID,
    asset: 'btc',
    destination: 'bc1qbob-as-entered',
    amountAtomic: '4000',
    feeAtomic: '154',
    createdAt: Date.UTC(2026, 9, 15, 8, 59),
  };
  const chain = mergeSendJournal(aliceHistory('"fee":154,"total_received":5846,"total_sent":10000'), [journal]);
  const [row] = rowsFor(mergePendingOutgoing([pending(TXID)], chain), TXID);
  assert.ok(row && row.kind === 'utxo');
  assert.equal(row.sent?.destination, 'bc1qbob-as-entered');
  assert.equal(row.sent?.fromInFlight, undefined);
});

test('a swap deposit keeps saying what it was for, and offers both the swap and the explorer', () => {
  const ctx = { kind: 'swap-deposit' as const, tradeId: 'T-1', toAsset: 'xmr', provider: 'trocador' };
  const [row] = rowsFor(
    mergePendingOutgoing([pending(TXID, { context: ctx })], aliceHistory('"fee":154,"total_received":5846,"total_sent":10000')),
    TXID,
  );
  assert.ok(row && row.kind === 'utxo');
  assert.deepEqual(row.context, ctx);
  const detail = buildTxDetail(row, 'btc', { explorerAvailable: true });
  assert.equal(detail.fields.find((f) => f.label === 'Trade ID')?.value, 'T-1');
  assert.ok(detail.actions.includes('open-swap'));
  assert.ok(detail.actions.includes('explorer'));
});

// ── Monero / Wownero ─────────────────────────────────────────────────────────

const xmrRow = (extra: Partial<Extract<AssetDetailTxRow, { kind: 'cryptonote' }>> = {}): AssetDetailTxRow => ({
  kind: 'cryptonote',
  direction: 'out',
  amountAtomic: 1_030_000_000n,
  txid: 'ab'.repeat(32),
  heightOrPending: 'pending',
  timestamp: '2026-10-15T09:00:05Z',
  ...extra,
});

test('an XMR send the LWS reports from the mempool appears once', () => {
  const rows = mergePendingOutgoing(
    [pending('ab'.repeat(32), { amountAtomic: 1_000_000_000n, feeAtomic: 30_000_000n, recipient: '4BOB' })],
    [xmrRow()],
  );
  assert.equal(rowsFor(rows, 'ab'.repeat(32)).length, 1);
  assert.equal(rows[0]?.kind, 'cryptonote');
});

test('an XMR row that shows only the change is still our send, for the amount sent', () => {
  // The LWS saw the change output before it could prove the spend: netted, the
  // row reads as a receive of the change.
  const [row] = mergePendingOutgoing(
    [pending('ab'.repeat(32), { amountAtomic: 1_000_000_000n, feeAtomic: 30_000_000n, recipient: '4BOB' })],
    [xmrRow({ direction: 'in', amountAtomic: 6_700_000_000n })],
  );
  assert.ok(row && row.kind === 'cryptonote');
  assert.equal(row.direction, 'out');
  assert.equal(row.amountAtomic, 1_000_000_000n);
});

test('an in-flight recipient on an XMR row claims nothing about a transaction key', () => {
  const [row] = mergePendingOutgoing(
    [pending('ab'.repeat(32), { recipient: '4BOB' })],
    [xmrRow()],
  );
  assert.ok(row && row.kind === 'cryptonote');
  const detail = buildTxDetail(row, 'xmr', { explorerAvailable: true });
  assert.equal(detail.fields.find((f) => f.label === 'Sent to')?.value, '4BOB');
  assert.ok(!detail.actions.includes('reveal-tx-key'));
  assert.doesNotMatch(detail.note ?? '', /subaddress/);
});
