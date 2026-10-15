/**
 * A history read that fails is reported as a failure, never as an empty list.
 *
 * The coin screen renders `[]` as "No activity yet". When the UTXO history
 * request failed (or its rows could not be mapped), that is what every BTC and
 * LTC wallet showed, funds and all. The read now throws a typed error the
 * screen turns into an explicit error with a retry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { utxoHistoryRows, HistoryUnavailableError } from '../history-mapping';

test('a failed history response throws, carrying the cause', () => {
  assert.throws(
    () => utxoHistoryRows({ error: 'upstream node unavailable' }),
    (e: unknown) => e instanceof HistoryUnavailableError && /upstream node unavailable/.test(e.message),
  );
});

test('a response with no body throws rather than reading as empty', () => {
  assert.throws(() => utxoHistoryRows({}), HistoryUnavailableError);
});

test('a genuinely empty history is empty, not an error', () => {
  assert.deepEqual(utxoHistoryRows({ data: { transactions: [] } }), []);
});

test('a backend-shaped history with null fields yields one row per transaction', () => {
  const body = JSON.parse(`{
    "asset": "ltc",
    "address": "ltc1qalice",
    "transactions": [
      { "txid": "aa", "height": 3000001, "fee": null, "total_received": 206000000, "total_sent": 0 },
      { "txid": "bb", "height": 0, "fee": 2260, "total_received": 0, "total_sent": null }
    ]
  }`) as Parameters<typeof utxoHistoryRows>[0]['data'];
  const rows = utxoHistoryRows({ data: body });
  assert.equal(rows.length, 2);
  // Unconfirmed reads first.
  assert.equal(rows[0]?.kind === 'utxo' && rows[0].heightOrPending, 'pending');
});
