/**
 * Premium-purchase helpers for the G-premium live lane: the backend's premium
 * capability, the wallet's remembered invoice, the feed's posting state, and
 * reading a Litecoin payment request from the owner's BTCPay checkout.
 *
 * Nothing here prints. The wallet fingerprint that scopes the remembered
 * invoice is resolved inside the extension page and never reaches Node.
 */

import { expect, type Page } from '@playwright/test';
import { BACKEND_URL } from './extension.js';
import type { GuardedFootage } from './G-premium-footage.js';

// ── backend capability ──────────────────────────────────────────────────────

export interface PremiumPlan { id: string; days: number; amount: string; label?: string }
export interface PremiumRail { id: string; assets: string[] }
export interface PremiumCaps {
  features: { premium_relay?: boolean; feed?: boolean };
  premium?: { currency: string; plans: PremiumPlan[]; relay_url: string; rails?: PremiumRail[] };
  messaging?: { write_policy?: string };
}

/** GET /capabilities on the backend under test, typed for premium. */
export async function premiumCapabilities(): Promise<PremiumCaps> {
  const res = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/capabilities`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`The backend capabilities answered HTTP ${res.status}.`);
  return (await res.json()) as PremiumCaps;
}

/**
 * The wallet's own naming rule (core/src/premium-purchase.ts), restated so the
 * spec checks the rendered result rather than importing the code under test.
 */
const PLAN_NAMES: Readonly<Record<string, string>> = { founding: 'Founding member', year: 'Standard', standard: 'Standard' };

export function expectedPlanLabel(plan: PremiumPlan, currency: string): string {
  const name = plan.label?.trim() || PLAN_NAMES[plan.id.toLowerCase()] || plan.id;
  const period = plan.days % 365 === 0 ? (plan.days === 365 ? '1 year' : `${plan.days / 365} years`)
    : plan.days === 1 ? '1 day' : `${plan.days} days`;
  return `${name}, ${period}, ${plan.amount} ${currency}`;
}

// ── the wallet's remembered invoice (chrome.storage.local) ──────────────────

export interface PendingInvoice {
  invoiceId: string;
  planId: string;
  rail: string | null;
  payTo: string;
  apiBase: string;
  createdAt: number;
}

/** The invoice this wallet remembers, or null. Read in the page by fingerprint. */
export async function readPendingInvoice(page: Page): Promise<PendingInvoice | null> {
  return page.evaluate(async () => {
    const stored = await chrome.storage.local.get('smirk_keystore_v1');
    const fingerprint = (stored.smirk_keystore_v1 as { fingerprint?: unknown } | undefined)?.fingerprint;
    if (typeof fingerprint !== 'string') throw new Error('no wallet keystore in this profile');
    const key = `smirk_premium_pending_v1:${fingerprint}`;
    const got = await chrome.storage.local.get(key);
    const pending = got[key] as Record<string, unknown> | undefined;
    if (!pending || typeof pending.invoiceId !== 'string') return null;
    return {
      invoiceId: pending.invoiceId,
      planId: String(pending.planId),
      rail: typeof pending.rail === 'string' ? pending.rail : null,
      payTo: String(pending.payTo),
      apiBase: String(pending.apiBase),
      createdAt: Number(pending.createdAt),
    };
  });
}

/**
 * Remember an invoice the way the wallet does, under this wallet's own key.
 * Used to reproduce a refusal the backend really sends (an invoice it does not
 * know); the activation request still goes to the real backend.
 */
export async function rememberInvoice(page: Page, pending: PendingInvoice): Promise<void> {
  await page.evaluate(async (record) => {
    const stored = await chrome.storage.local.get('smirk_keystore_v1');
    const fingerprint = (stored.smirk_keystore_v1 as { fingerprint?: unknown } | undefined)?.fingerprint;
    if (typeof fingerprint !== 'string') throw new Error('no wallet keystore in this profile');
    await chrome.storage.local.set({ [`smirk_premium_pending_v1:${fingerprint}`]: record });
  }, pending);
}

// ── navigation and feed state ───────────────────────────────────────────────

/** A tab tap restores that tab's last sub-screen; a second tap returns to its root. */
export async function tabRoot(page: Page, footage: GuardedFootage, tab: 'home' | 'feed', label: string): Promise<void> {
  const target = page.getByTestId(`nav-tab-${tab}`);
  await footage.tap(target, label);
  if (tab === 'home') await footage.tap(target, 'Back to the top of Home');
}

export type PostingState = 'composer' | 'needs-premium';

/**
 * Which posting surface the feed settles on. Premium status loads after the
 * screen mounts, so a premium wallet briefly shows the purchase screen; wait
 * until one surface has stayed put for five seconds.
 */
export async function feedPostingState(page: Page): Promise<PostingState> {
  const composer = page.getByTestId('feed-compose');
  const needs = page.getByTestId('feed-needs-premium');
  await expect(composer.or(needs)).toBeVisible({ timeout: 90_000 });
  let last: PostingState | null = null;
  let since = Date.now();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const now: PostingState = (await composer.isVisible()) ? 'composer' : 'needs-premium';
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= 5_000) {
      return now;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('The feed never settled on a posting surface.');
}

/**
 * Times at which the automatic-check status text changed to a new "last
 * checked" time. Watches until `count` changes or the deadline passes.
 */
export async function observeAutoChecks(page: Page, count: number, deadlineMs: number): Promise<number[]> {
  const status = page.getByTestId('premium-auto-status');
  const seen: number[] = [];
  let previous = (await status.textContent().catch(() => null)) ?? '';
  const deadline = Date.now() + deadlineMs;
  while (seen.length < count && Date.now() < deadline) {
    await page.waitForTimeout(200);
    const text = (await status.textContent().catch(() => null)) ?? '';
    if (text !== previous && /last checked/.test(text)) seen.push(Date.now());
    previous = text;
  }
  return seen;
}

// ── Litecoin payment request from the checkout ──────────────────────────────

export interface LitecoinRequest {
  address: string;
  /** Decimal LTC, at most 8 places, exactly as the checkout asks. */
  amount: string;
}

/** Mainnet Litecoin: native segwit, or legacy L and M. Never a 3 address, which BTC shares. */
export function isLitecoinAddress(address: string): boolean {
  return /^ltc1[02-9ac-hj-np-z]{8,87}$/.test(address) || /^[LM][1-9A-HJ-NP-Za-km-z]{26,33}$/.test(address);
}

/** `litecoin:<address>?amount=<decimal>`, in either case; null when anything is off. */
export function parseLitecoinUri(uri: string): LitecoinRequest | null {
  const match = /^litecoin:([^?]+)\?(.+)$/i.exec(uri.trim());
  if (!match) return null;
  let address = decodeURIComponent(match[1]!);
  if (/^LTC1/.test(address)) address = address.toLowerCase();
  const params = new URLSearchParams(match[2]!);
  const amount = params.get('amount') ?? params.get('AMOUNT');
  if (!amount || !/^\d+(\.\d{1,8})?$/.test(amount) || !isLitecoinAddress(address)) return null;
  return { address, amount };
}

/** Decimal LTC to litoshi, exactly. */
export function toLitoshi(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  if (!/^\d+$/.test(whole ?? '') || !/^\d{0,8}$/.test(fraction)) throw new Error('not a decimal LTC amount');
  return BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

function findLitecoinUri(value: unknown, depth = 0): LitecoinRequest | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === 'string') return /^litecoin:/i.test(value) ? parseLitecoinUri(value) : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLitecoinUri(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Prefer the plain link over the upper-cased QR form.
    for (const key of ['invoiceBitcoinUrl', 'paymentUrl', 'bip21']) {
      const found = findLitecoinUri(record[key], depth + 1);
      if (found) return found;
    }
    for (const item of Object.values(record)) {
      const found = findLitecoinUri(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The Litecoin address and amount the owner's checkout asks for this invoice.
 * First the checkout page itself (choosing Litecoin there if it is not the
 * default), then the checkout's own status endpoint for the same invoice.
 */
export async function readLitecoinRequest(checkout: Page, footage: GuardedFootage, invoiceId: string): Promise<LitecoinRequest> {
  const fromPage = async (): Promise<LitecoinRequest | null> => {
    const links = await checkout.locator('a[href^="litecoin:" i]')
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
    for (const link of links) {
      const found = parseLitecoinUri(link);
      if (found) return found;
    }
    return null;
  };
  let found = await fromPage();
  if (!found) {
    const choice = checkout.getByRole('link', { name: /^\s*(LTC|Litecoin)\b/i })
      .or(checkout.getByRole('button', { name: /^\s*(LTC|Litecoin)\b/i }))
      .or(checkout.getByRole('tab', { name: /^\s*(LTC|Litecoin)\b/i }))
      .first();
    if (await choice.isVisible().catch(() => false)) {
      await footage.tap(choice, 'Choose Litecoin at the checkout');
      await footage.settled(checkout, 'Litecoin chosen at the checkout');
    }
    const deadline = Date.now() + 30_000;
    while (!found && Date.now() < deadline) {
      found = await fromPage();
      if (!found) await checkout.waitForTimeout(1_000);
    }
  }
  if (!found) {
    const origin = new URL(checkout.url()).origin;
    const id = encodeURIComponent(invoiceId);
    for (const path of [
      `/i/${id}/status?paymentMethodId=LTC-CHAIN`,
      `/i/${id}/status?paymentMethodId=LTC`,
      `/i/${id}/LTC/status`,
      `/invoice/status?invoiceId=${id}&paymentMethodId=LTC`,
    ]) {
      const res = await checkout.request.get(`${origin}${path}`, { failOnStatusCode: false, timeout: 20_000 }).catch(() => null);
      if (!res?.ok()) continue;
      found = findLitecoinUri(await res.json().catch(() => null));
      if (found) break;
    }
  }
  if (!found) throw new Error('The checkout offered no readable Litecoin payment request for this invoice.');
  return found;
}

// ── balances ────────────────────────────────────────────────────────────────

export interface AssetBalance { amount: number | null; usd: number | null }

/** A Home asset row: the coin amount and, when prices load, its USD value. */
export async function readAssetBalance(page: Page, asset: 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin'): Promise<AssetBalance> {
  const amountText = (await page.getByTestId(`asset-row-${asset}-balance`).textContent({ timeout: 60_000 })) ?? '';
  const rowText = (await page.getByTestId(`asset-row-${asset}`).innerText({ timeout: 60_000 })) ?? '';
  const amount = /(\d[\d,]*(?:\.\d+)?)/.exec(amountText.replace(/\s/g, ''));
  const usd = /\$\s?(\d[\d,]*(?:\.\d+)?)/.exec(rowText);
  return {
    amount: amount ? Number(amount[1]!.replace(/,/g, '')) : null,
    usd: usd ? Number(usd[1]!.replace(/,/g, '')) : null,
  };
}
