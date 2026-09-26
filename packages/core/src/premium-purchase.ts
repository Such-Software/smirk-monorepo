/**
 * Pure decisions behind buying premium from the wallet.
 *
 * Kept out of the route so they can be tested without chrome storage or a
 * backend: how a plan and a payment method are described, which methods to
 * offer, and when a remembered invoice is still worth trying to redeem.
 */

import type { PremiumPlanInfo, PremiumRailInfo } from './api/capabilities';

/** "1 year", "90 days", "1 day". Whole years read as years; nothing else does. */
export function planPeriodLabel(days: number): string {
  if (days > 0 && days % 365 === 0) {
    const years = days / 365;
    return years === 1 ? '1 year' : `${years} years`;
  }
  return days === 1 ? '1 day' : `${days} days`;
}

/** "1 year for 5 USD". */
export function planLabel(plan: PremiumPlanInfo, currency: string): string {
  return `${planPeriodLabel(plan.days)} for ${plan.amount} ${currency}`.trim();
}

/**
 * The payment methods to offer, in the backend's order.
 *
 * A backend that predates rails advertises none; it still takes payment on its
 * one processor, so that is offered as a single unnamed method with `id`
 * `null`, which the caller must send as NO rail at all. Sending a guessed id
 * would be refused.
 */
export function offeredRails(rails: PremiumRailInfo[] | undefined): Array<{
  id: string | null;
  label: string;
}> {
  if (!rails || rails.length === 0) return [{ id: null, label: 'Pay' }];
  return rails.map((r) => ({ id: r.id, label: railLabel(r) }));
}

/** "BTC · LTC · GRIN". A rail with no declared assets is named, not guessed at. */
export function railLabel(rail: PremiumRailInfo): string {
  const assets = rail.assets.map((a) => a.trim().toUpperCase()).filter(Boolean);
  return assets.length ? assets.join(' · ') : rail.id;
}

/** An invoice the user was sent to pay, remembered across the popup closing. */
export interface PendingPremiumInvoice {
  invoiceId: string;
  planId: string;
  /** Rail it was minted on; `null` for a backend without rails. */
  rail: string | null;
  payTo: string;
  /** Which backend minted it: an invoice is only redeemable where it was made. */
  apiBase: string;
  createdAt: number;
}

/**
 * How long a remembered invoice is worth offering to redeem. Processors expire
 * an UNPAID invoice after about an hour, but a PAID one can take longer to
 * settle (on-chain confirmations), and the backend keeps it redeemable until
 * used. A day covers slow confirmations without leaving a stale button around
 * indefinitely.
 */
export const PENDING_PREMIUM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Whether a remembered invoice should still be offered on this backend. */
export function isPendingRedeemable(
  pending: PendingPremiumInvoice | null | undefined,
  apiBase: string,
  nowMs: number,
): pending is PendingPremiumInvoice {
  if (!pending || !pending.invoiceId) return false;
  if (pending.apiBase !== apiBase) return false;
  const age = nowMs - pending.createdAt;
  return age >= 0 && age <= PENDING_PREMIUM_MAX_AGE_MS;
}

/**
 * Only a checkout URL is opened. Some processors return a bare address instead;
 * opening that as a URL would navigate somewhere meaningless, so the caller
 * shows it to copy instead.
 */
export function isCheckoutUrl(payTo: string): boolean {
  try {
    const u = new URL(payTo);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
