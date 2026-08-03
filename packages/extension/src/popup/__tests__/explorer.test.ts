/**
 * Explorer URL builders + row timestamp (extracted from index.tsx). Pure: asserts
 * the per-asset/per-row-kind URL mapping and the null cases (Grin has no per-tx URL).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AssetDetailTxRow } from '@smirk/ui';

import { rowTimestamp, explorerUrlForRow, explorerUrlForPendingOutgoing } from '../explorer';

test('explorerUrlForRow: per-asset UTXO + cryptonote + grin-kernel; null otherwise', () => {
  assert.equal(
    explorerUrlForRow('btc', { kind: 'utxo', txid: 'abc' } as AssetDetailTxRow),
    'https://mempool.space/tx/abc',
  );
  assert.equal(
    explorerUrlForRow('ltc', { kind: 'utxo', txid: 'abc' } as AssetDetailTxRow),
    'https://litecoinspace.org/tx/abc',
  );
  assert.equal(
    explorerUrlForRow('xmr', { kind: 'cryptonote', txid: 't' } as AssetDetailTxRow),
    'https://xmrchain.net/tx/t',
  );
  assert.equal(
    explorerUrlForRow('grin', { kind: 'grin', kernelExcess: 'kx' } as AssetDetailTxRow),
    'https://grincoin.org/kernel/kx',
  );
  // grin without a kernel excess → no link
  assert.equal(explorerUrlForRow('grin', { kind: 'grin' } as AssetDetailTxRow), null);
});

test('explorerUrlForPendingOutgoing: UTXO/cryptonote have URLs, grin does not', () => {
  assert.equal(explorerUrlForPendingOutgoing('btc', 'x'), 'https://mempool.space/tx/x');
  assert.equal(explorerUrlForPendingOutgoing('xmr', 'x'), 'https://xmrchain.net/tx/x');
  assert.equal(explorerUrlForPendingOutgoing('grin', 'x'), null);
});

test('rowTimestamp: parses timestamps, null for UTXO + unparseable', () => {
  assert.equal(rowTimestamp({ kind: 'utxo', txid: 'x' } as AssetDetailTxRow), null);
  const iso = '2026-07-07T00:00:00.000Z';
  assert.equal(
    rowTimestamp({ kind: 'cryptonote', timestamp: iso } as unknown as AssetDetailTxRow),
    Date.parse(iso),
  );
  assert.equal(
    rowTimestamp({ kind: 'pending-outgoing', submittedAt: iso } as unknown as AssetDetailTxRow),
    Date.parse(iso),
  );
});
