/**
 * Block-explorer URL builders + row timestamp extraction for the Activity list.
 * Pure (no React, no module state); extracted from index.tsx. Grin's Mimblewimble
 * model has no per-tx URL — kernel-excess links where available, else null.
 */

import type { AssetDetailTxRow } from '@smirk/ui';

/** Sortable timestamp (ms) for an Activity row, or null when it has none (UTXO
 *  rows carry no timestamp; pending-outgoing uses its broadcast time). */
export function rowTimestamp(row: AssetDetailTxRow): number | null {
  if (row.kind === 'utxo') return null;
  const iso = row.kind === 'pending-outgoing' ? row.submittedAt : row.timestamp;
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Explorer URL for a tap on a tx row, or null when the chain/row has none. */
export function explorerUrlForRow(assetId: string, row: AssetDetailTxRow): string | null {
  if (row.kind === 'utxo') {
    if (assetId === 'btc') return `https://mempool.space/tx/${row.txid}`;
    if (assetId === 'ltc') return `https://litecoinspace.org/tx/${row.txid}`;
  }
  if (row.kind === 'cryptonote') {
    if (assetId === 'xmr') return `https://xmrchain.net/tx/${row.txid}`;
    if (assetId === 'wow') return `https://explore.wownero.com/tx/${row.txid}`;
  }
  if (row.kind === 'grin' && row.kernelExcess) {
    return `https://grincoin.org/kernel/${row.kernelExcess}`;
  }
  return null;
}

/** Explorer URL for a `pending-outgoing` row's broadcast txid. Grin returns null
 *  (no per-tx URL in Mimblewimble). */
export function explorerUrlForPendingOutgoing(assetId: string, txid: string): string | null {
  if (assetId === 'btc') return `https://mempool.space/tx/${txid}`;
  if (assetId === 'ltc') return `https://litecoinspace.org/tx/${txid}`;
  if (assetId === 'xmr') return `https://xmrchain.net/tx/${txid}`;
  if (assetId === 'wow') return `https://explore.wownero.com/tx/${txid}`;
  return null;
}
