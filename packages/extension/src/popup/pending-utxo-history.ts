import type {
  ChainProviderRegistry,
  PendingOutgoingTx,
  UtxoAddressRef,
  UtxoTxStatus,
} from '@smirk/core';

/**
 * Backend tx history for each UTXO asset with an in-flight pendingOutgoing
 * entry, so a balance refresh can tell a spend that was mined (drop the entry)
 * from one still in the mempool (keep deducting it); see
 * `reconcileUtxoPendingOutgoing`. Read over the same address set as the
 * balance: the fresh-address scan set when the host built one, else the
 * primary address. Nothing is read while nothing is in flight. A failed read
 * is null: unknown, so the entries stay.
 */
export async function readPendingUtxoHistory(
  providers: Pick<ChainProviderRegistry, 'utxo'>,
  addresses: { btc: string; ltc: string },
  entries: readonly PendingOutgoingTx[],
  refs: { btc?: UtxoAddressRef[]; ltc?: UtxoAddressRef[] } | undefined,
): Promise<Partial<Record<'btc' | 'ltc', UtxoTxStatus[] | null>>> {
  const out: Partial<Record<'btc' | 'ltc', UtxoTxStatus[] | null>> = {};
  await Promise.all(
    (['btc', 'ltc'] as const)
      .filter((asset) => entries.some((e) => e.asset === asset))
      .map(async (asset) => {
        try {
          const set = refs?.[asset];
          const r =
            set && set.length > 0
              ? await providers.utxo(asset).getHistoryMulti(set.map((x) => x.address))
              : await providers.utxo(asset).getHistory(addresses[asset]);
          out[asset] = r.error || !r.data ? null : r.data.transactions;
        } catch {
          out[asset] = null;
        }
      }),
  );
  return out;
}
