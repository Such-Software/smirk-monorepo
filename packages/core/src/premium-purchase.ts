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

/**
 * Names for the plan ids operators use. Two plans can share a period (a launch
 * promo beside the standing price), so the period alone does not tell them
 * apart; the name does.
 */
const PLAN_NAMES: Record<string, string> = {
  founding: 'Founding member',
  year: 'Standard',
  standard: 'Standard',
};

/**
 * The plan's name: the backend's own label when it sends one, else the known
 * name for its id, else the id itself in sentence case. Never empty.
 */
export function planName(plan: PremiumPlanInfo): string {
  const fromBackend = plan.label?.trim();
  if (fromBackend) return fromBackend;
  const id = plan.id.trim();
  const known = PLAN_NAMES[id.toLowerCase()];
  if (known) return known;
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Plan';
}

/** "Founding member, 1 year, 5 USD". */
export function planLabel(plan: PremiumPlanInfo, currency: string): string {
  return `${planName(plan)}, ${planPeriodLabel(plan.days)}, ${plan.amount} ${currency}`.trim();
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
 * Automatic checking for a paid invoice while the purchase screen is open.
 *
 * Each check asks the backend, which asks the processor, so the schedule backs
 * off: often at first, while the user is likely still at the checkout, then
 * slower for on-chain confirmations, and it stops after an hour. The manual
 * "check now" button stays available throughout and after.
 */
export const PREMIUM_POLL_FAST_MS = 15_000;
export const PREMIUM_POLL_SLOW_MS = 60_000;
/** Checks run fast for this long after the invoice was minted. */
export const PREMIUM_POLL_FAST_WINDOW_MS = 10 * 60 * 1000;
/** No automatic check is scheduled this long after the invoice was minted. */
export const PREMIUM_POLL_MAX_MS = 60 * 60 * 1000;

/**
 * Delay before the next automatic check, or `null` when automatic checking is
 * over for this invoice. Measured from the invoice's mint time, so reopening
 * the popup does not restart the hour.
 */
export function nextPremiumPollDelayMs(createdAt: number, nowMs: number): number | null {
  const age = nowMs - createdAt;
  if (age < 0 || age >= PREMIUM_POLL_MAX_MS) return null;
  const delay = age < PREMIUM_POLL_FAST_WINDOW_MS ? PREMIUM_POLL_FAST_MS : PREMIUM_POLL_SLOW_MS;
  // Never schedule past the cap.
  return Math.min(delay, PREMIUM_POLL_MAX_MS - age);
}

/**
 * What an unsuccessful activation means for automatic checking.
 *
 * `waiting`: not settled yet, or the payment method is briefly unavailable;
 * keep checking. `final`: the invoice can never activate here (unknown, bound
 * to someone else, already used); stop checking and say so. Decided on the
 * backend's words because its 400s share one status code.
 */
export function premiumActivationOutcome(error: string | undefined): 'waiting' | 'final' {
  const e = (error ?? '').toLowerCase();
  if (e.includes('already been used') || e.includes('unknown or invalid')) return 'final';
  return 'waiting';
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
