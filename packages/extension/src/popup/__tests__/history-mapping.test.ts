/**
 * Transaction-history mapping invariants.
 *
 * These cover the decisions that made Activity lie on every chain:
 *   - a Monero/Wownero row whose only link to us is a ring decoy is not ours,
 *   - a send with change is a SEND, not a receive of the change,
 *   - one transaction touching several of our addresses is one row,
 *   - a backend that reports no amounts must not be rendered as "0".
 *
 * Properties, not fixtures: no exact wording or list length is asserted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  settleCryptonote,
  dedupeByTxid,
  sortUtxoTxs,
  utxoTxToRow,
  mergeSendJournal,
  blockTimeIso,
} from '../history-mapping';
import type { SendJournalEntry } from '../send-journal';

// ── Cryptonote ───────────────────────────────────────────────────────────────

test('a decoy-only appearance is not our transaction', () => {
  // monero-lws reports a row for every transaction that merely used one of our
  // outputs as a ring member. Nothing received, nothing we proved we spent.
  assert.equal(settleCryptonote(0n, 0n), null);
});

test('an unverified candidate spend never becomes a send', () => {
  // The caller passes only key-image-VERIFIED spend value. A row carrying huge
  // candidate spends but no proven ones must still read as not-ours.
  const provenNone = 0n;
  assert.equal(settleCryptonote(0n, provenNone), null);
});

test('a send with change is a send, for the amount that actually left', () => {
  // 7 in, 6.7 back as change => 0.3 left the wallet.
  const settled = settleCryptonote(6_700_000_000_000n, 7_000_000_000_000n);
  assert.ok(settled);
  assert.equal(settled.direction, 'out');
  assert.equal(settled.amountAtomic, 300_000_000_000n);
});

test('a plain receive is a receive', () => {
  const settled = settleCryptonote(500n, 0n);
  assert.ok(settled);
  assert.equal(settled.direction, 'in');
  assert.equal(settled.amountAtomic, 500n);
});

test('the reported amount is never negative, whichever way it nets', () => {
  for (const [recv, spent] of [
    [0n, 900n],
    [10n, 900n],
    [900n, 10n],
    [900n, 900n],
  ] as Array<[bigint, bigint]>) {
    const settled = settleCryptonote(recv, spent);
    if (settled) assert.ok(settled.amountAtomic >= 0n, `negative for ${recv}/${spent}`);
  }
});

// ── UTXO ─────────────────────────────────────────────────────────────────────

test('one transaction across several of our addresses collapses to one row', () => {
  const same = { txid: 'aa', height: 5 };
  const rows = dedupeByTxid([same, { ...same }, { ...same }, { txid: 'bb', height: 6 }]);
  assert.equal(rows.length, 2);
});

test('dedup keeps the sighting that carries a fee', () => {
  const rows = dedupeByTxid([
    { txid: 'aa', height: 5 },
    { txid: 'aa', height: 5, fee: 250 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.fee, 250);
});

test('history reads newest first, with unconfirmed on top', () => {
  const sorted = sortUtxoTxs([
    { txid: 'old', height: 1 },
    { txid: 'new', height: 900 },
    { txid: 'mempool', height: 0 },
  ]);
  assert.equal(sorted[0]?.txid, 'mempool');
  assert.ok((sorted[1]?.height ?? 0) > (sorted[2]?.height ?? 0));
});

test('a backend that reports no amounts yields no amount, not zero', () => {
  // Electrum's get_history carries only txid/height/fee. Defaulting the missing
  // fields to 0 rendered every BTC and LTC row as a confident "sent 0".
  const row = utxoTxToRow({ txid: 'aa', height: 10 });
  assert.equal(row.kind, 'utxo');
  assert.ok(!('amountAtomic' in row) || row.amountAtomic === undefined);
});

test('a UTXO send with change is a send, netted', () => {
  const row = utxoTxToRow({ txid: 'aa', height: 10, total_received: 70, total_sent: 100 });
  assert.equal(row.direction, 'out');
  assert.equal(row.kind === 'utxo' ? row.amountAtomic : undefined, 30n);
});

test('a credit with no known debit is not reported as a receive', () => {
  // Electrum reports the spent side only when the server resolved every input's
  // prevout. Ours does not, so a SEND arrives as just its change. Claiming that
  // as an incoming transfer is the bug this mapping exists to prevent, and
  // knowing one side is not knowing the amount.
  const row = utxoTxToRow({ txid: 'aa', height: 10, total_received: 70 });
  assert.ok(!('amountAtomic' in row) || row.amountAtomic === undefined);
});

test('a UTXO receive is a receive when both sides are known', () => {
  const row = utxoTxToRow({ txid: 'aa', height: 10, total_received: 70, total_sent: 0 });
  assert.equal(row.direction, 'in');
  assert.equal(row.kind === 'utxo' ? row.amountAtomic : undefined, 70n);
});

test('an unconfirmed UTXO row is marked pending', () => {
  assert.equal(utxoTxToRow({ txid: 'aa', height: 0 }).heightOrPending, 'pending');
});

// ── Send journal merge ───────────────────────────────────────────────────────

const journalEntry = (txid: string, extra: Partial<SendJournalEntry> = {}): SendJournalEntry => ({
  txid,
  asset: 'xmr',
  destination: '4DEST',
  amountAtomic: '700',
  feeAtomic: '9',
  createdAt: Date.UTC(2026, 9, 7),
  ...extra,
});

test('a recorded send is merged onto its chain row by txid, case-insensitively', () => {
  const rows = mergeSendJournal(
    [
      { kind: 'cryptonote', direction: 'out', amountAtomic: 709n, txid: 'ABCD', heightOrPending: 5, timestamp: '2026-10-07T00:00:00Z' },
      { kind: 'cryptonote', direction: 'in', amountAtomic: 1n, txid: 'ffff', heightOrPending: 6, timestamp: '2026-10-07T00:00:00Z' },
    ],
    [journalEntry('abcd', { txKeyHex: 'k'.repeat(64) })],
  );
  const [sent, other] = rows;
  assert.ok(sent && sent.kind === 'cryptonote' && sent.sent);
  assert.equal(sent.sent.destination, '4DEST');
  assert.equal(sent.sent.hasTxKey, true);
  // The chain's netted amount stays authoritative.
  assert.equal(sent.amountAtomic, 709n);
  assert.ok(other && other.kind === 'cryptonote' && other.sent === undefined);
});

test('the transaction key never lands on a history row', () => {
  const rows = mergeSendJournal(
    [{ kind: 'cryptonote', direction: 'out', amountAtomic: 1n, txid: 'aa', heightOrPending: 1, timestamp: '2026-10-07T00:00:00Z' }],
    [journalEntry('aa', { txKeyHex: 'secretkey'.repeat(7) })],
  );
  assert.ok(!JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).includes('secretkey'));
});

test('a UTXO send the backend could not net takes the recorded amount and time', () => {
  const [row] = mergeSendJournal(
    [utxoTxToRow({ txid: 'bb', height: 10 })],
    [journalEntry('bb', { asset: 'btc' })],
  );
  assert.ok(row && row.kind === 'utxo');
  assert.equal(row.direction, 'out');
  assert.equal(row.amountAtomic, 700n);
  assert.ok(row.timestamp);
  assert.equal(row.feeAtomic, 9n);
});

test('a UTXO row with a backend block time keeps it', () => {
  const [row] = mergeSendJournal(
    [utxoTxToRow({ txid: 'cc', height: 10, timestamp: 1_700_000_000 })],
    [journalEntry('cc', { asset: 'btc', createdAt: Date.UTC(2030, 0, 1) })],
  );
  assert.ok(row && row.kind === 'utxo');
  assert.equal(row.timestamp, new Date(1_700_000_000 * 1000).toISOString());
});

test('backend block times are unix seconds; junk yields none', () => {
  assert.equal(blockTimeIso(1_700_000_000), new Date(1_700_000_000_000).toISOString());
  assert.equal(blockTimeIso(0), null);
  assert.equal(blockTimeIso('not a date'), null);
  assert.equal(blockTimeIso(undefined), null);
});
