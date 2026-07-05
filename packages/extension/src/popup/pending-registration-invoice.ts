/**
 * Durable record of an in-flight pay-to-register invoice, so a popup closed
 * mid-payment does not strand the operator fee. When a payment-gated onboarding
 * mints an invoice we persist its id here (keyed by the wallet fingerprint). Any
 * later unlock auto-includes it in the register attempt, so registration
 * completes the moment the operator's processor reports the invoice settled, even
 * hours later. Cleared on the first successful registration.
 *
 * Backed by chrome.storage.local (survives popup close and browser restart),
 * unlike the in-memory refs the active payment poll uses.
 */
import { ChromeLocalStorage } from '@smirk/core';

const KEY = 'smirk_pending_registration_invoice_v1';
const storage = new ChromeLocalStorage();

interface PendingInvoice {
  fingerprint: string;
  invoiceId: string;
  at: number;
}

/** Persist the minted invoice for this wallet (overwrites any prior pending). */
export async function setPendingRegistrationInvoice(
  fingerprint: string,
  invoiceId: string,
): Promise<void> {
  await storage.set(KEY, { fingerprint, invoiceId, at: Date.now() });
}

/** The pending invoice id for this wallet, or null. Fingerprint-scoped so a
 *  different wallet's bootstrap never picks up a stale record. */
export async function getPendingRegistrationInvoice(
  fingerprint: string,
): Promise<string | null> {
  const v = await storage.get<PendingInvoice>(KEY);
  return v && v.fingerprint === fingerprint ? v.invoiceId : null;
}

/** Clear the record only if it belongs to this wallet (a successful register). */
export async function clearPendingRegistrationInvoice(
  fingerprint: string,
): Promise<void> {
  const v = await storage.get<PendingInvoice>(KEY);
  if (v && v.fingerprint === fingerprint) {
    await storage.remove(KEY);
  }
}
