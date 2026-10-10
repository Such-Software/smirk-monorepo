/**
 * Premium-purchase helpers for the G-premium live lane: the backend's premium
 * capability, the wallet's remembered invoice, the feed's posting state,
 * reading a Litecoin payment request from the owner's BTCPay checkout, and
 * reading a payment back from the wallet's balance and history.
 *
 * Nothing here prints. The wallet fingerprint that scopes the remembered
 * invoice is resolved inside the extension page and never reaches Node.
 */

import { expect, type Locator, type Page } from '@playwright/test';
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

export function expectedPlanName(plan: PremiumPlan): string {
  const fromBackend = plan.label?.trim();
  if (fromBackend) return fromBackend;
  const known = PLAN_NAMES[plan.id.trim().toLowerCase()];
  if (known) return known;
  const words = plan.id.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Plan';
}

export function expectedPlanLabel(plan: PremiumPlan, currency: string): string {
  const period = plan.days > 0 && plan.days % 365 === 0 ? (plan.days === 365 ? '1 year' : `${plan.days / 365} years`)
    : plan.days === 1 ? '1 day' : `${plan.days} days`;
  return `${expectedPlanName(plan)}, ${period}, ${plan.amount} ${currency}`.trim();
}

/**
 * The payment methods the wallet offers, restated from core/src/premium-purchase.ts:
 * none advertised is one unnamed method (no rail element at all); one is named
 * "Pays in <assets>"; more than one is a "Pay with" choice, first selected.
 */
export function expectedRails(rails: PremiumRail[] | undefined): Array<{ id: string | null; label: string }> {
  if (!rails || rails.length === 0) return [{ id: null, label: 'Pay' }];
  return rails.map((rail) => {
    const assets = rail.assets.map((a) => a.trim().toUpperCase()).filter(Boolean);
    return { id: rail.id, label: assets.length ? assets.join(' · ') : rail.id };
  });
}

/** The cheapest advertised plan: the only one the purchase lane will pay for. */
export function cheapestPlan(plans: PremiumPlan[]): PremiumPlan {
  const priced = plans.filter((p) => /^\d+(\.\d+)?$/.test(p.amount) && Number(p.amount) > 0);
  if (priced.length === 0) throw new Error('The backend advertises no plan with a plain positive price.');
  return priced.reduce((low, p) => (Number(p.amount) < Number(low.amount) ? p : low));
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

/**
 * The top of Home. A tab tap restores that tab's last sub-screen, so it is
 * held, then a second tap returns to the root, which is held too.
 */
export async function goHome(page: Page, footage: GuardedFootage): Promise<void> {
  const home = page.getByTestId('nav-tab-home');
  await footage.tap(home, 'Go to Home');
  await footage.settled(page, 'Home tab');
  await footage.tap(home, 'Back to the top of Home');
  await expect(page.getByTestId('home-total-balance')).toBeVisible({ timeout: 60_000 });
  await footage.settled(page, 'Top of Home');
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

/** The checkout's own status endpoint for this invoice, on the pinned host only. */
async function litecoinRequestFromStatus(checkout: Page, checkoutHost: string, invoiceId: string): Promise<LitecoinRequest | null> {
  const origin = `https://${checkoutHost}`;
  const id = encodeURIComponent(invoiceId);
  for (const path of [
    `/i/${id}/status?paymentMethodId=LTC-CHAIN`,
    `/i/${id}/status?paymentMethodId=LTC`,
    `/i/${id}/LTC/status`,
    `/invoice/status?invoiceId=${id}&paymentMethodId=LTC`,
  ]) {
    const res = await checkout.request.get(`${origin}${path}`, { failOnStatusCode: false, timeout: 20_000, maxRedirects: 0 })
      .catch(() => null);
    if (!res?.ok()) continue;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') continue;
    // A status for some other invoice is never this invoice's request.
    if (typeof body.invoiceId === 'string' && body.invoiceId !== invoiceId) {
      throw new Error('The checkout status endpoint answered for a different invoice; refusing to pay.');
    }
    const found = findLitecoinUri(body);
    if (found) return found;
  }
  return null;
}

/**
 * The Litecoin address and amount the owner's checkout asks for this invoice.
 *
 * Funds go only to the owner's own BTCPay checkout, so this fails closed: the
 * checkout must be open on the pinned host, the page itself must show a
 * Litecoin payment link (choosing Litecoin there if it is not the default),
 * and the checkout's own status endpoint for the same invoice, asked on the
 * same pinned host, must name exactly the same address and amount.
 */
export async function readLitecoinRequest(
  checkout: Page,
  footage: GuardedFootage,
  invoiceId: string,
  checkoutHost: string,
): Promise<LitecoinRequest> {
  const onPinnedHost = (): void => {
    const here = new URL(checkout.url());
    if (here.protocol !== 'https:' || here.host !== checkoutHost) {
      throw new Error('The checkout is not open on the pinned owner BTCPay host (G_PREMIUM_CHECKOUT_HOST); refusing to read a payment request from it.');
    }
  };
  onPinnedHost();
  const fromPage = async (): Promise<LitecoinRequest | null> => {
    const links = await checkout.locator('a[href^="litecoin:" i]')
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
    for (const link of links) {
      const found = parseLitecoinUri(link);
      if (found) return found;
    }
    return null;
  };
  if (!(await fromPage())) {
    const choice = checkout.getByRole('link', { name: /^\s*(LTC|Litecoin)\b/i })
      .or(checkout.getByRole('button', { name: /^\s*(LTC|Litecoin)\b/i }))
      .or(checkout.getByRole('tab', { name: /^\s*(LTC|Litecoin)\b/i }))
      .first();
    if (await choice.isVisible().catch(() => false)) {
      await footage.tap(choice, 'Choose Litecoin at the checkout');
      await footage.settled(checkout, 'Litecoin chosen at the checkout');
    }
    await expect.poll(fromPage, {
      timeout: 30_000,
      message: 'the checkout page never showed a Litecoin payment link',
    }).not.toBeNull();
  }
  onPinnedHost();
  const onPage = await fromPage();
  if (!onPage) throw new Error('The checkout page shows no Litecoin payment link for this invoice.');
  const status = await litecoinRequestFromStatus(checkout, checkoutHost, invoiceId);
  if (!status) {
    throw new Error("The checkout's own status endpoint gave no Litecoin payment request for this invoice; refusing to pay on the page's word alone.");
  }
  if (status.address !== onPage.address) {
    throw new Error('The checkout page and its status endpoint name different Litecoin addresses; refusing to pay either.');
  }
  if (toLitoshi(status.amount) !== toLitoshi(onPage.amount)) {
    throw new Error('The checkout page and its status endpoint ask different amounts; refusing to pay either.');
  }
  return onPage;
}

// ── balances ────────────────────────────────────────────────────────────────

export interface AssetBalance { amount: number | null; usd: number | null }

type AssetId = 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin';

/**
 * A Home asset row: the coin amount and, when prices load, its USD value. The
 * row is cut to the asset's display decimals (4 for LTC), never rounded up, so
 * it can only understate a balance; the asset detail has full precision.
 */
export async function readAssetBalance(page: Page, asset: AssetId): Promise<AssetBalance> {
  const amountText = (await page.getByTestId(`asset-row-${asset}-balance`).textContent({ timeout: 60_000 })) ?? '';
  const rowText = (await page.getByTestId(`asset-row-${asset}`).innerText({ timeout: 60_000 })) ?? '';
  const amount = /(\d[\d,]*(?:\.\d+)?)/.exec(amountText.replace(/\s/g, ''));
  const usd = /\$\s?(\d[\d,]*(?:\.\d+)?)/.exec(rowText);
  return {
    amount: amount ? Number(amount[1]!.replace(/,/g, '')) : null,
    usd: usd ? Number(usd[1]!.replace(/,/g, '')) : null,
  };
}

/** The Home row once it shows a number; it shows a dash while loading. */
export async function waitForAssetBalance(page: Page, asset: AssetId): Promise<{ amount: number; usd: number | null }> {
  await expect.poll(async () => (await readAssetBalance(page, asset)).amount, {
    timeout: 5 * 60_000,
    message: `the ${asset.toUpperCase()} row never showed a balance`,
  }).not.toBeNull();
  const read = await readAssetBalance(page, asset);
  if (read.amount === null) throw new Error(`The ${asset.toUpperCase()} row stopped showing a balance.`);
  return { amount: read.amount, usd: read.usd };
}

async function readDetailBalance(page: Page): Promise<string | null> {
  const text = ((await page.getByTestId('asset-detail-balance').textContent().catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();
  return /^(\d+(?:\.\d{1,12})?) [A-Z]+$/.exec(text)?.[1] ?? null;
}

/**
 * The asset detail's confirmed balance at full precision (8 decimals for LTC),
 * as the exact decimal it shows, once it shows one (never while hidden).
 */
export async function waitForDetailBalance(page: Page): Promise<string> {
  await expect.poll(() => readDetailBalance(page), {
    timeout: 5 * 60_000,
    message: 'the asset detail never showed a balance',
  }).not.toBeNull();
  const value = await readDetailBalance(page);
  if (value === null) throw new Error('The asset detail stopped showing a balance.');
  return value;
}

// ── history and activation ──────────────────────────────────────────────────

/** How an activity row shortens a transaction id (AssetDetailScreen truncId). */
export function shortTxid(txid: string): string {
  return txid.length <= 14 ? txid : `${txid.slice(0, 6)}…${txid.slice(-6)}`;
}

/**
 * The activity row for this transaction on an asset detail. A chain row names
 * its id through a "Copy transaction ID" control; a still-pending local row
 * names the recipient instead, so only a row the history reports matches.
 */
export function activityRow(page: Page, txid: string): Locator {
  const id = page.locator('button[aria-label="Copy transaction ID"]', { hasText: shortTxid(txid) });
  return page.locator('button', { has: id }).first();
}

/** Where to tap a row so it opens its detail rather than copying its id. */
export function rowOpener(row: Locator): Locator {
  return row.locator(':scope > span').first();
}

/** The `premium_until` an activation answer granted, as epoch ms, or null. */
export function premiumUntilOf(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { premium_until?: unknown; data?: { premium_until?: unknown } };
    const until = parsed.premium_until ?? parsed.data?.premium_until;
    const at = typeof until === 'string' ? Date.parse(until) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}
