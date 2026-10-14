/**
 * Which THORChain vault addresses a quoted deposit may name.
 *
 * THORChain runs several Asgard vaults per chain. A quote names one of them,
 * and `inbound_addresses` advertises one, not necessarily the same one. On
 * 2026-10-14, during a churn, a BTC quote named the active vault
 * bc1q704ak5... while `inbound_addresses` named bc1qh2aq97..., and the oracle
 * that compared the two stopped a correct deposit at Review.
 *
 * A deposit is acceptable when the chain is not halted and the address is one
 * of its ActiveVault addresses. A retiring vault is refused: it still accepts
 * funds, but no quote should hand one out. Pure, so the rule is testable
 * offline; the live fixture fetches the two documents.
 */

/**
 * @param {string} chain THORChain chain id, e.g. 'BTC'.
 * @param {Array<{ chain?: string, halted?: boolean }>} inbound `/thorchain/inbound_addresses`.
 * @param {Array<{ status?: string, addresses?: Array<{ chain?: string, address?: string }> }>} asgard `/thorchain/vaults/asgard`.
 * @returns {string[]} the active vault addresses for `chain`.
 */
export function activeVaultAddresses(chain, inbound, asgard) {
  const entry = inbound.find((x) => x.chain === chain);
  if (!entry) throw new Error(`THORChain publishes no ${chain} inbound entry`);
  if (entry.halted) throw new Error(`THORChain has halted ${chain}`);
  const addresses = asgard
    .filter((v) => v.status === 'ActiveVault')
    .flatMap((v) => v.addresses ?? [])
    .filter((a) => a.chain === chain && typeof a.address === 'string' && a.address.length > 0)
    .map((a) => a.address);
  if (addresses.length === 0) throw new Error(`THORChain lists no active ${chain} vault`);
  return [...new Set(addresses)];
}
