/**
 * Durable record of an in-flight pay-to-register invoice, so a popup closed
 * mid-payment does not strand the operator fee. When a payment-gated onboarding
 * mints an invoice we persist its id here, keyed by the wallet fingerprint AND
 * the backend that minted it. A later sign-in at that same backend
 * auto-includes it in the register attempt, so registration completes the
 * moment the operator's processor reports the invoice settled, even hours
 * later. Cleared on the first successful registration there.
 *
 * Backend-scoped because an invoice is only redeemable where it was minted.
 * Keyed by wallet alone, a pay-to-register pending at one operator was sent to
 * whatever backend the wallet signed in at next, for instance after the
 * bootstrap-error screen's "switch backend" reset it to the default: that
 * operator learned another operator's invoice id, and one that answered it as
 * "payment pending" held the wallet on "payment still confirming" for up to the
 * full TTL. Premium invoices bind their backend the same way
 * (`PendingPremiumInvoice.apiBase` in core).
 *
 * A record written before this binding names no backend. Nothing says which
 * operator minted it, so it is never attached anywhere; it ages out with the
 * TTL like any other record.
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
  /** The backend that minted the invoice. Absent on a record written before
   *  invoices were bound to their backend. */
  backendUrl?: string;
  invoiceId: string;
  at: number;
}

/** Persist the invoice `backendUrl` minted for this wallet (overwrites any
 *  prior pending record). */
export async function setPendingRegistrationInvoice(
  fingerprint: string,
  backendUrl: string,
  invoiceId: string,
): Promise<void> {
  const record: PendingInvoice = { fingerprint, backendUrl, invoiceId, at: Date.now() };
  await storage.set(KEY, record);
}

/** The pending invoice id this wallet holds at `backendUrl`, or null. A record
 *  for another wallet or another backend is never returned. Returns null (and
 *  clears the record) once older than {@link PENDING_TTL_MS} so a dead invoice
 *  can't strand the wallet. */
export async function getPendingRegistrationInvoice(
  fingerprint: string,
  backendUrl: string,
): Promise<string | null> {
  const v = await storage.get<PendingInvoice>(KEY);
  if (!v || v.fingerprint !== fingerprint) return null;
  if (typeof v.at === 'number' && Date.now() - v.at > PENDING_TTL_MS) {
    await storage.remove(KEY);
    return null;
  }
  if (!v.backendUrl || v.backendUrl !== backendUrl) return null;
  return v.invoiceId;
}

/** Clear the record only if it belongs to this wallet at `backendUrl` (a
 *  successful register there). A sign-in elsewhere leaves it for its backend. */
export async function clearPendingRegistrationInvoice(
  fingerprint: string,
  backendUrl: string,
): Promise<void> {
  const v = await storage.get<PendingInvoice>(KEY);
  if (v && v.fingerprint === fingerprint && v.backendUrl === backendUrl) {
    await storage.remove(KEY);
  }
}

/** Force a fresh mint: drop this wallet's pending record at `backendUrl` so the
 *  next onboarding attempt requests a new invoice instead of re-attaching a dead
 *  one. Distinct from {@link clearPendingRegistrationInvoice} only in intent. */
export async function resetPendingRegistrationInvoice(
  fingerprint: string,
  backendUrl: string,
): Promise<void> {
  await clearPendingRegistrationInvoice(fingerprint, backendUrl);
}
