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

/**
 * How long a pending invoice stays auto-attachable. An underpaid / expired /
 * never-settled invoice must NOT pin the wallet in "payment still confirming"
 * forever: past this window `getPendingRegistrationInvoice` treats the
 * record as dead and clears it, so onboarding can mint a fresh invoice. Chosen
 * generously (24h) so a slow on-chain confirmation is never dropped prematurely.
 */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

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
 *  different wallet's bootstrap never picks up a stale record. Returns null (and
 *  clears the record) once older than {@link PENDING_TTL_MS} so a dead invoice
 *  can't strand the wallet. */
export async function getPendingRegistrationInvoice(
  fingerprint: string,
): Promise<string | null> {
  const v = await storage.get<PendingInvoice>(KEY);
  if (!v || v.fingerprint !== fingerprint) return null;
  if (typeof v.at === 'number' && Date.now() - v.at > PENDING_TTL_MS) {
    await storage.remove(KEY);
    return null;
  }
  return v.invoiceId;
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

/** Force a fresh mint: drop this wallet's pending record unconditionally so the
 *  next onboarding attempt requests a new invoice instead of re-attaching a dead
 *  one. Distinct from {@link clearPendingRegistrationInvoice} only in
 *  intent — both are fingerprint-scoped. */
export async function resetPendingRegistrationInvoice(
  fingerprint: string,
): Promise<void> {
  await clearPendingRegistrationInvoice(fingerprint);
}
