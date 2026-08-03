/** Returns true iff a `pending` tip's funding has stalled: zero
 *  confirmations beyond a generous wall-clock cutoff. Used to drop
 *  abandoned tips from the Inbox and per-asset history. */
export const STALE_TIP_NO_CONF_MS = 24 * 60 * 60 * 1000;
export function isTipStale(
  fundingConfirmations: number,
  createdAtIso: string,
): boolean {
  if (fundingConfirmations > 0) return false;
  const created = Date.parse(createdAtIso);
  if (Number.isNaN(created)) return false;
  return Date.now() - created > STALE_TIP_NO_CONF_MS;
}
