/**
 * The premium invoice the user was last sent to pay, remembered per wallet.
 *
 * Opening the checkout opens a tab, and opening a tab closes the popup. Without
 * this, the invoice id existed only in the popup's memory, so coming back after
 * paying left nothing to redeem: the user had paid and the wallet had forgotten
 * what for. The backend keeps a paid invoice redeemable until used, so all the
 * wallet has to do is remember which one.
 *
 * Bound to the wallet fingerprint for the same reason the send journal is: an
 * invoice is bound server-side to the account that minted it, and another seed
 * on this browser profile could not redeem it anyway.
 */

import type { PendingPremiumInvoice } from '@smirk/core';

const KEY = 'smirk_premium_pending_v1';

function scoped(fingerprint: string): string {
  return `${KEY}:${fingerprint}`;
}

/** The remembered invoice for this wallet, or `null`. Never throws. */
export async function loadPendingPremium(
  fingerprint: string | undefined,
): Promise<PendingPremiumInvoice | null> {
  if (!fingerprint) return null;
  try {
    const got = await chrome.storage.local.get(scoped(fingerprint));
    const v = got[scoped(fingerprint)] as PendingPremiumInvoice | undefined;
    return v && typeof v.invoiceId === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Remember an invoice. Best-effort: losing it costs a retry, never money. */
export async function savePendingPremium(
  fingerprint: string | undefined,
  pending: PendingPremiumInvoice,
): Promise<void> {
  if (!fingerprint) return;
  try {
    await chrome.storage.local.set({ [scoped(fingerprint)]: pending });
  } catch {
    // Display state only.
  }
}

/** Forget the invoice, once redeemed or abandoned. */
export async function clearPendingPremium(fingerprint: string | undefined): Promise<void> {
  if (!fingerprint) return;
  try {
    await chrome.storage.local.remove(scoped(fingerprint));
  } catch {
    // Display state only.
  }
}
