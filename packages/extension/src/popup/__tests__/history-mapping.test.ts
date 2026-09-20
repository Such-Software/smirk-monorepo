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
} from '../history-mapping';

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

test('a UTXO receive is a receive', () => {
  const row = utxoTxToRow({ txid: 'aa', height: 10, total_received: 70 });
  assert.equal(row.direction, 'in');
  assert.equal(row.kind === 'utxo' ? row.amountAtomic : undefined, 70n);
});

test('an unconfirmed UTXO row is marked pending', () => {
  assert.equal(utxoTxToRow({ txid: 'aa', height: 0 }).heightOrPending, 'pending');
});
