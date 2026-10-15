/**
 * The XMR/WOW chain tip is the `blockchain_height` an LWS history reports,
 * taken as it stands.
 *
 * monero-lws sets that field to `get_last_block().id`: the height of the
 * newest block, not a count of blocks. The coin screen subtracted one from it,
 * so every Monero and Wownero confirmation count read one short, and a
 * transaction in the newest block showed "Block #N" rather than one
 * confirmation. These checks run a backend-shaped history through the tip the
 * screen derives and the detail sheet that turns it into a count.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTxDetail, type AssetDetailTxRow } from '@smirk/ui';

import { lwsTipHeight } from '../history-mapping';

// A history as smirk-backend-core relays it from monero-lws: the newest block
// the LWS holds is 3_784_108, and our transaction was mined in it.
const HISTORY = JSON.parse(`{
  "asset": "xmr",
  "transactions": [{ "txid": "9a", "height": 3784108, "timestamp": "2026-10-15T10:00:00Z" }],
  "scanned_height": 3784108,
  "blockchain_height": 3784108
}`) as { blockchain_height: number; transactions: Array<{ txid: string; height: number; timestamp: string }> };

const rowAt = (height: number): AssetDetailTxRow => ({
  kind: 'cryptonote',
  direction: 'in',
  amountAtomic: 1n,
  txid: '9a',
  heightOrPending: height,
  timestamp: '2026-10-15T10:00:00Z',
});

/** The count the detail sheet states, or null when it can only name the block. */
function confirmationsShown(height: number, blockchainHeight: number): number | null {
  const tip = lwsTipHeight(blockchainHeight);
  const status = buildTxDetail(rowAt(height), 'xmr', tip === undefined ? {} : { tipHeight: tip })
    .fields.find((f) => f.label === 'Status')?.value;
  const m = /^(\d+) confirmations? /.exec(status ?? '');
  return m ? Number(m[1]) : null;
}

test('a transaction in the newest block the LWS reports has one confirmation', () => {
  const [tx] = HISTORY.transactions;
  assert.ok(tx);
  assert.equal(confirmationsShown(tx.height, HISTORY.blockchain_height), 1);
});

test('confirmations are tip minus height plus one, at every depth', () => {
  const tip = 3_784_108;
  for (const depth of [0, 1, 9, 10, 59]) {
    assert.equal(confirmationsShown(tip - depth, tip), depth + 1, `depth ${depth}`);
  }
});

test('the reported height is the tip itself, with nothing subtracted', () => {
  assert.equal(lwsTipHeight(3_784_108), 3_784_108);
  assert.equal(lwsTipHeight(1), 1);
});

test('a missing or zero height is unknown, so no count is claimed', () => {
  for (const h of [0, undefined, null, Number.NaN, -5]) {
    assert.equal(lwsTipHeight(h), undefined, String(h));
  }
  assert.equal(confirmationsShown(3_784_108, 0), null);
});
