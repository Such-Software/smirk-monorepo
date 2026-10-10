/**
 * G-premium (live, production): premium plans, invoices and automatic checking
 * on the v0.3.1 release candidate, driven through the real wallet UI.
 *
 *   1. Plans are named: the backend's label when it sends one, else the name
 *      for its id ("founding" reads "Founding member", "year" reads
 *      "Standard"). Payment methods follow the advertised rails: one rail is
 *      named by its assets ("Pays in BTC · LTC · GRIN"); several are a "Pay
 *      with" choice. The config this run saw is evidence, not an assertion, so
 *      a new label, price or rail changes what is checked, not the result.
 *   2. Each advertised plan mints an invoice on the btcpay rail whose checkout
 *      opens the owner's BTCPay page; the automatic check ticks every 15 s;
 *      Check now gets the server's "not yet confirmed"; Start over abandons it.
 *      The invoice survives leaving the screen; the abandon survives it too.
 *   3. Refusal: an invoice the backend does not know is refused once, and a
 *      fixed 40 s watch (more than two 15 s poll periods, recorded or not) sees
 *      no further automatic check. (The "already used" refusal is reproduced
 *      in 4, the only place a real used invoice exists.)
 *   4. Declared only with the purchase flags: the purchase wallet pays the
 *      cheapest plan in LTC to the pinned owner checkout, from a third window.
 *      Of two windows waiting on the invoice, one activates premium (with
 *      premium_until about one plan period ahead) and gets the composer; the
 *      other is refused with "already used". The payment is then found in the
 *      wallet's LTC history by its txid. Posting needs the owner's separate
 *      approval.
 *
 * Gates, each its own opt-in (names only; no values on command lines). Bad
 * combinations refuse when the spec loads, before any wallet work
 * (fixtures/G-premium-config.ts):
 *   E2E_LIVE=1             declare these tests at all (the default suite never sees them)
 *   ALLOW_PROD_WRITES=1    mint real invoices on a shared backend (2, 3 and 4)
 *   E2E_LIVE_MONEY=1 and E2E_PREMIUM_PURCHASE=1   declare 4 and pay the cheapest plan
 *   G_PREMIUM_CHECKOUT_HOST    the owner's BTCPay host; required for 4, checked in 2 when set
 *   G_PREMIUM_PURCHASE_WALLET  alice|bob|carol, the wallet that pays (default alice);
 *                          must differ from the browsing wallet
 *   E2E_PREMIUM_POST=1     owner approval to publish one public note after activation
 *   G_PREMIUM_BROWSE_WALLET    alice|bob|carol, the wallet that mints and abandons (default carol)
 *   G_PREMIUM_MAX_LTC      refuse to pay a checkout asking more (default 0.12 LTC)
 *   G_PREMIUM_MAX_USD      refuse to buy a plan priced above this (default 5 USD)
 *   FOOTAGE=guarded        record through the guarded recorder (fixtures/G-premium-footage.ts)
 *
 * The backend caps each account at eight unpaid premium invoices whose payment
 * window is still open (count_unconsumed_premium_invoices counts
 * `consumed_at IS NULL AND expires_at > NOW()`; expires_at is set at mint from
 * registration.payment.expires_minutes, 60 by default). Each run of scenario 2
 * holds one slot per advertised plan for about that long.
 *
 * Every declared test must run. A skip (premium already active, the invoice
 * cap reached, too little LTC) fails the skip guard on purpose: it names what
 * this run did not prove. A purchase leaves its wallet premium for a year, so
 * the next purchase run sets G_PREMIUM_PURCHASE_WALLET to another wallet.
 *
 * Run from packages/e2e (the custody file is read in-process, never sourced).
 * Browsing only, scenarios 1 to 3:
 *   E2E_LIVE=1 ALLOW_PROD_WRITES=1 FOOTAGE=guarded E2E_MIN_EXECUTED=3 \
 *   BACKEND_URL=https://api.smirk.cash/api/v1 EXTENSION_DIST=<unpacked staged chrome zip> \
 *   LIVE_WALLET_FILE=<main checkout>/packages/smoke-tests/secrets/smoke-mnemonics.env \
 *   npx playwright test tests/live/g-premium.live.spec.ts
 * The recorded release run, all four: the same, plus E2E_LIVE_MONEY=1
 * E2E_PREMIUM_PURCHASE=1 G_PREMIUM_CHECKOUT_HOST=<owner BTCPay host>, with
 * E2E_MIN_EXECUTED=4.
 * Then encode: node scripts/G-premium-footage.mjs --run <footage run directory>
 */

import { randomBytes } from 'node:crypto';
import type { Page, Response } from '@playwright/test';
import { test, expect, LIVE, type LiveWallet } from '../../fixtures/G-premium-wallets.js';
import { BACKEND_URL, skipDestructiveOnShared } from '../../fixtures/extension.js';
import type { GuardedFootage } from '../../fixtures/G-premium-footage.js';
import { loadPremiumLaneConfig } from '../../fixtures/G-premium-config.js';
import {
  activityRow,
  cheapestPlan,
  expectedPlanLabel,
  expectedRails,
  feedPostingState,
  goHome,
  isLitecoinAddress,
  observeAutoChecks,
  premiumCapabilities,
  premiumUntilOf,
  readLitecoinRequest,
  readPendingInvoice,
  rememberInvoice,
  rowOpener,
  toLitoshi,
  waitForAssetBalance,
  waitForDetailBalance,
  type PremiumCaps,
  type PremiumPlan,
} from '../../fixtures/G-premium-checkout.js';

const CONFIG = LIVE ? loadPremiumLaneConfig(process.env, BACKEND_URL) : null;
const BROWSE = CONFIG?.browse ?? 'carol';
const PURCHASE = CONFIG?.purchase ?? null;
const CHECKOUT_HOST = CONFIG?.checkoutHost ?? null;

/** The prices the v0.3.1 release review saw: compared and annotated, never asserted. */
const RELEASE_PRICES: Readonly<Record<string, string>> = { founding: '5', year: '15' };

/** The backend's own words (smirk-backend-core src/api/premium.rs). */
const SAYS = {
  notConfirmed: /Payment not yet confirmed/i,
  unknown: /Unknown or invalid premium invoice/i,
  used: /already been used/i,
  tooMany: /Too many pending premium invoices/i,
};
const AUTO_RUNNING = 'Checking for your payment automatically';
const AUTO_STOPPED = /Automatic checking has stopped/;
const NOTE_TEXT = 'Smirk Wallet v0.3.1 release check: premium posting works.';

/** After a final refusal, watch this long for another automatic check: more than two 15 s polls. */
const QUIET_WATCH_MS = 40_000;
/** One round of waiting for a payment to settle. The same with or without footage. */
const SETTLE_ROUND_MS = 60_000;
/** Past the hour of automatic checks, at most one Check now per window this often (one LTC block). */
const MANUAL_CHECK_EVERY_MS = 150_000;
const DAY_MS = 24 * 60 * 60_000;

/** Shared between the serial tests of one run (one worker). */
const run: { apiBase?: string; checkoutOrigin?: string } = {};

async function premiumOrSkip(): Promise<{ caps: PremiumCaps; currency: string; plans: PremiumPlan[] }> {
  const caps = await premiumCapabilities();
  test.skip(!caps.features.premium_relay || !caps.premium, 'the backend does not advertise premium_relay with plans');
  test.skip(!caps.features.feed, 'the backend advertises no feed, so the wallet has no purchase screen');
  return { caps, currency: caps.premium!.currency, plans: caps.premium!.plans };
}

/** Open the Feed on this window and let it settle. */
async function openFeed(page: Page, footage: GuardedFootage): Promise<void> {
  await footage.tap(page.getByTestId('nav-tab-feed'), 'Open the Feed');
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 60_000 });
  await footage.settled(page, 'Feed settled');
}

/** Leave the Feed and come back, so the purchase screen reloads its state. */
async function reopenFeed(page: Page, footage: GuardedFootage): Promise<void> {
  await footage.tap(page.getByTestId('nav-tab-home'), 'Leave the Feed');
  await footage.settled(page, 'Away from the Feed');
  await footage.tap(page.getByTestId('nav-tab-feed'), 'Return to the Feed');
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 60_000 });
}

/** The plan picker, clearing a remembered invoice an interrupted run left behind. */
async function planPicker(page: Page, footage: GuardedFootage): Promise<void> {
  const buy = page.getByTestId('premium-buy');
  const leftover = page.getByTestId('premium-abandon');
  await expect(buy.or(leftover)).toBeVisible({ timeout: 60_000 });
  if (await leftover.isVisible()) {
    await footage.tap(leftover, 'Start over on a leftover invoice');
    await expect(buy).toBeVisible({ timeout: 30_000 });
    await footage.settled(page, 'Plan picker');
  }
  await expect(buy).toBeVisible({ timeout: 30_000 });
}

/** The btcpay rail, chosen when the wallet offers a choice. This lane checks BTCPay checkouts only. */
async function chooseBtcpay(page: Page, footage: GuardedFootage, caps: PremiumCaps): Promise<void> {
  const rails = caps.premium?.rails ?? [];
  if (!rails.some((r) => r.id === 'btcpay')) {
    throw new Error('The backend no longer offers the btcpay rail; this lane checks BTCPay checkouts only.');
  }
  if (rails.length < 2) return;
  const rail = page.getByTestId('premium-rail-btcpay');
  if ((await rail.getAttribute('aria-checked')) === 'true') return;
  await footage.tap(rail, 'Pay through BTCPay');
  await expect(rail).toHaveAttribute('aria-checked', 'true');
  await footage.settled(page, 'BTCPay chosen');
}

/** The next activation answer from this window's backend calls. */
function activationAnswer(page: Page, timeout = 45_000): Promise<Response | null> {
  return page.waitForResponse(
    (res) => res.url().endsWith('/premium/activate') && res.request().method() === 'POST',
    { timeout },
  ).catch(() => null);
}

/**
 * Check now, until the manual check itself is answered. A tap made while an
 * automatic check is in flight is ignored by the wallet, so it retries.
 */
async function checkNow(page: Page, footage: GuardedFootage, expected: RegExp): Promise<void> {
  const message = page.getByTestId('premium-message');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await footage.settled(page, 'Check now was busy');
    const answered = activationAnswer(page);
    await footage.tap(page.getByTestId('premium-redeem'), 'Check now');
    if (!(await answered)) continue;
    await expect(page.getByTestId('premium-redeem')).toHaveText('Check now', { timeout: 30_000 });
    if (await message.filter({ hasText: expected }).waitFor({ timeout: 10_000 }).then(() => true, () => false)) return;
  }
  throw new Error('Check now never produced the expected answer from the backend.');
}

/** Mint an invoice for the selected plan and return the checkout tab it opened. */
async function mint(wallet: LiveWallet, page: Page, footage: GuardedFootage): Promise<Page> {
  const opened = wallet.context.waitForEvent('page', { timeout: 90_000 });
  opened.catch(() => {});
  await footage.tap(page.getByTestId('premium-buy'), 'Get premium');
  const outcome = await Promise.race([
    opened.then((tab) => ({ kind: 'tab' as const, tab })),
    page.getByTestId('premium-message').waitFor({ timeout: 90_000 }).then(() => ({ kind: 'refused' as const })),
  ]).catch(() => ({ kind: 'none' as const }));
  if (outcome.kind === 'tab') return outcome.tab;
  if (outcome.kind === 'none') throw new Error('Get premium neither opened a checkout nor reported a refusal.');
  const said = ((await page.getByTestId('premium-message').textContent()) ?? '').trim();
  if (SAYS.tooMany.test(said)) {
    await footage.result(page, 'Invoice limit reached');
    footage.evidence(`invoice_cap_reached_${wallet.name}`, true);
    test.skip(true, `${wallet.name} has eight unpaid premium invoices still inside their payment window, the backend cap. `
      + 'Each frees its slot when it expires (registration.payment.expires_minutes after minting, 60 by default); '
      + 'wait, or use G_PREMIUM_BROWSE_WALLET.');
  }
  throw new Error(`The backend refused the invoice: ${said.slice(0, 160)}`);
}

/** The checkout tab is the owner's BTCPay page for exactly this invoice. */
async function expectCheckoutFor(tab: Page, invoiceId: string, payTo: string): Promise<URL> {
  await expect.poll(() => tab.url(), { timeout: 90_000, message: 'the checkout tab never navigated' }).toMatch(/^https:\/\//);
  await tab.waitForLoadState('domcontentloaded', { timeout: 90_000 });
  const opened = new URL(tab.url());
  const promised = new URL(payTo);
  expect(promised.protocol, 'the backend handed out a non-https checkout').toBe('https:');
  expect(promised.pathname, 'the checkout link is not a BTCPay invoice page').toBe(`/i/${invoiceId}`);
  expect(opened.host, 'the checkout opened somewhere other than the link the wallet remembered').toBe(promised.host);
  expect(opened.pathname, 'the checkout opened for a different invoice').toContain(invoiceId);
  expect(opened.host, 'the checkout must not be the wallet backend').not.toBe(new URL(BACKEND_URL).host);
  if (CHECKOUT_HOST) {
    expect(promised.host, 'the backend named a checkout off the owner BTCPay host').toBe(CHECKOUT_HOST);
    expect(opened.host, 'the checkout is not on the owner BTCPay host').toBe(CHECKOUT_HOST);
  }
  if (run.checkoutOrigin) expect(opened.origin, 'two plans opened checkouts on different hosts').toBe(run.checkoutOrigin);
  await expect(tab.locator('body'), 'the checkout page shows no payment methods').toContainText(/\b(BTC|LTC|Bitcoin|Litecoin)\b/, { timeout: 90_000 });
  return opened;
}

if (LIVE) {
  test.describe('G-premium: premium plans, invoices and automatic checking', () => {
    test.describe.configure({ mode: 'serial' });

    test('plans and payment methods are named as the backend advertises them', async ({ live, footage }) => {
      test.setTimeout(45 * 60_000);
      const { caps, currency, plans } = await premiumOrSkip();
      expect(plans.length, 'the backend advertises premium with no plans').toBeGreaterThan(0);
      for (const p of plans) {
        expect(p.amount, `the ${p.id} plan has no plain price`).toMatch(/^\d+(\.\d+)?$/);
        expect(p.days, `the ${p.id} plan has no period`).toBeGreaterThan(0);
      }
      const rails = expectedRails(caps.premium!.rails);

      // What this run saw. A change is noted, and the checks below follow it.
      const labelled = plans.filter((p) => p.label?.trim()).length;
      footage.evidence('plans_seen', plans.map((p) => `${p.id} ${p.days}d ${p.amount}`).join(', '));
      footage.evidence('plan_labels_from_backend', labelled);
      footage.evidence('currency_seen', currency);
      footage.evidence('rails_seen', rails.map((r) => r.id ?? 'none').join(', '));
      const notes = test.info().annotations;
      for (const [id, price] of Object.entries(RELEASE_PRICES)) {
        const advertised = plans.find((p) => p.id === id);
        if (advertised?.amount !== price) {
          notes.push({ type: 'config-change', description: `${id} is ${advertised ? 'priced differently from' : 'missing from'} the v0.3.1 release review` });
        }
      }
      if (labelled) notes.push({ type: 'config-change', description: `the backend now labels ${labelled} plan(s); checked against its labels` });
      if (rails.length > 1) notes.push({ type: 'config-change', description: `${rails.length} payment rails; checked as a choice` });

      const wallet = await live.get(BROWSE);
      const page = wallet.page;
      footage.mark('Premium plans and payment methods', wallet.name);
      await footage.settled(page, 'Wallet ready');
      await openFeed(page, footage);
      const state = await feedPostingState(page);
      test.skip(state === 'composer', `${wallet.name} can already post (premium or write allowlist), so no purchase screen is offered`);
      await expect(page.getByTestId('feed-needs-premium')).toContainText('Posting to this feed needs a premium subscription');
      await planPicker(page, footage);

      // Plans: the backend's label, else the name for the id, else the id.
      for (const p of plans) {
        await expect(page.getByTestId(`premium-plan-${p.id}`)).toHaveText(expectedPlanLabel(p, currency));
      }
      const unlabelled = (id: string) => plans.some((p) => p.id === id && !p.label?.trim());
      if (unlabelled('founding')) await expect(page.getByTestId('premium-plan-founding')).toHaveText(/^Founding member, /);
      if (unlabelled('year')) await expect(page.getByTestId('premium-plan-year')).toHaveText(/^Standard, /);
      await expect(page.locator('[role="radio"][data-testid^="premium-plan-"]')).toHaveCount(plans.length);
      const firstPlan = page.getByTestId(`premium-plan-${plans[0]!.id}`);
      await expect(firstPlan, 'the first plan is chosen by default').toHaveAttribute('aria-checked', 'true');
      for (const p of plans.slice(1)) await expect(page.getByTestId(`premium-plan-${p.id}`)).toHaveAttribute('aria-checked', 'false');

      // Payment methods: none named, one named by its assets, or a choice.
      const railElements = page.locator('[data-testid^="premium-rail-"]');
      if (rails.length === 1 && rails[0]!.id === null) {
        await expect(railElements).toHaveCount(0);
      } else if (rails.length === 1) {
        await expect(page.getByTestId('premium-rail-single')).toHaveText(`Pays in ${rails[0]!.label}`);
        await expect(railElements).toHaveCount(1);
      } else {
        await expect(page.getByRole('radiogroup', { name: 'Pay with' })).toBeVisible();
        await expect(page.getByTestId('premium-rail-single')).toHaveCount(0);
        for (const [i, r] of rails.entries()) {
          await expect(page.getByTestId(`premium-rail-${r.id}`)).toHaveText(r.label);
          await expect(page.getByTestId(`premium-rail-${r.id}`)).toHaveAttribute('aria-checked', i === 0 ? 'true' : 'false');
        }
      }
      await expect(page.getByTestId('premium-buy')).toHaveText('Get premium');
      await expect(page.getByTestId('premium-buy')).toBeEnabled();
      await footage.result(page, 'Plans and payment methods');

      // Choosing moves the selection, and choosing back restores it.
      for (const p of plans.slice(1)) {
        const id = p.id;
        await footage.tap(page.getByTestId(`premium-plan-${id}`), id === 'year' ? 'Choose the Standard plan' : 'Choose another plan');
        await expect(page.getByTestId(`premium-plan-${id}`)).toHaveAttribute('aria-checked', 'true');
        await expect(firstPlan).toHaveAttribute('aria-checked', 'false');
        await footage.result(page, 'Another plan chosen');
      }
      for (const r of rails.slice(1)) {
        await footage.tap(page.getByTestId(`premium-rail-${r.id}`), 'Choose another payment method');
        await expect(page.getByTestId(`premium-rail-${r.id}`)).toHaveAttribute('aria-checked', 'true');
        await footage.result(page, 'Another payment method chosen');
      }
      if (rails.length > 1) {
        await footage.tap(page.getByTestId(`premium-rail-${rails[0]!.id}`), 'Choose the first payment method');
        await expect(page.getByTestId(`premium-rail-${rails[0]!.id}`)).toHaveAttribute('aria-checked', 'true');
        await footage.settled(page, 'First payment method chosen');
      }
      if (plans.length > 1) {
        const id = plans[0]!.id;
        await footage.tap(firstPlan, id === 'founding' ? 'Choose the Founding member plan' : 'Choose the first plan');
        await expect(firstPlan).toHaveAttribute('aria-checked', 'true');
        await footage.settled(page, 'First plan chosen');
      }
    });

    test('each plan mints a btcpay invoice that auto-checks, checks now and is abandoned', async ({ live, footage }) => {
      test.setTimeout(90 * 60_000);
      test.skip(skipDestructiveOnShared(), 'mints real BTCPay invoices on a shared backend; set ALLOW_PROD_WRITES=1');
      const { caps, currency, plans } = await premiumOrSkip();
      const wallet = await live.get(BROWSE);
      const page = wallet.page;
      await openFeed(page, footage);
      test.skip((await feedPostingState(page)) === 'composer', `${wallet.name} can already post, so no purchase screen is offered`);

      for (const chosen of plans) {
        const id = chosen.id;
        footage.mark(id === 'founding' ? 'Founding member invoice' : 'Invoice for another plan', wallet.name);
        await planPicker(page, footage);
        await footage.tap(page.getByTestId(`premium-plan-${id}`), id === 'founding' ? 'Choose the Founding member plan' : 'Choose another plan');
        await expect(page.getByTestId(`premium-plan-${id}`)).toHaveAttribute('aria-checked', 'true');
        await expect(page.getByTestId(`premium-plan-${id}`)).toHaveText(expectedPlanLabel(chosen, currency));
        await footage.settled(page, 'Plan chosen');
        await chooseBtcpay(page, footage, caps);

        const checkout = await mint(wallet, page, footage);
        const pending = await readPendingInvoice(page);
        expect(pending, 'the wallet did not remember the invoice before opening the checkout').not.toBeNull();
        expect(pending!.planId).toBe(id);
        expect(pending!.rail).toBe('btcpay');
        expect(new URL(pending!.apiBase).host, 'the invoice is bound to another backend').toBe(new URL(BACKEND_URL).host);
        const opened = await expectCheckoutFor(checkout, pending!.invoiceId, pending!.payTo);
        run.checkoutOrigin = opened.origin;
        run.apiBase = pending!.apiBase;
        footage.evidence(`unpaid_invoice_${id.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30)}`, pending!.invoiceId);
        await footage.settled(checkout, 'Checkout loaded');
        await footage.result(checkout, 'Owner BTCPay checkout for this invoice');

        // Back in the wallet: the pending screen, checking on its own.
        await page.bringToFront();
        const status = page.getByTestId('premium-auto-status');
        await expect(status).toContainText(AUTO_RUNNING);
        await expect(page.getByTestId('premium-checkout-link')).toHaveAttribute('href', pending!.payTo);
        await expect(page.getByTestId('premium-checkout-link')).toHaveText('Open the checkout again');
        const ticks = await observeAutoChecks(page, 3, 120_000);
        expect(ticks.length, 'the automatic check stopped ticking').toBe(3);
        for (let i = 1; i < ticks.length; i++) {
          const interval = ticks[i]! - ticks[i - 1]!;
          expect(interval, 'automatic checks are not about 15 s apart').toBeGreaterThanOrEqual(12_000);
          expect(interval, 'automatic checks are not about 15 s apart').toBeLessThanOrEqual(30_000);
        }
        // Waiting automatically is quiet: no message until something is decided.
        await expect(page.getByTestId('premium-message')).toHaveCount(0);
        await footage.result(page, 'Automatic check ticks every 15 seconds');

        // The link reopens the same checkout.
        const reopened = wallet.context.waitForEvent('page', { timeout: 60_000 });
        await footage.tap(page.getByTestId('premium-checkout-link'), 'Open the checkout again');
        const again = await reopened;
        await expectCheckoutFor(again, pending!.invoiceId, pending!.payTo);
        await footage.settled(again, 'Checkout reopened');
        await footage.closePage(again, 'Close the reopened checkout');
        await page.bringToFront();
        await footage.settled(page, 'Invoice pending in the wallet');

        // Leaving the screen keeps the invoice (the popup closes when the checkout opens).
        await reopenFeed(page, footage);
        await expect(status).toContainText(AUTO_RUNNING);
        expect((await readPendingInvoice(page))?.invoiceId, 'the invoice was forgotten on leaving the screen').toBe(pending!.invoiceId);
        await footage.settled(page, 'Invoice still remembered');

        await checkNow(page, footage, SAYS.notConfirmed);
        await expect(status, 'a waiting answer must not stop automatic checking').toContainText(AUTO_RUNNING);
        await footage.result(page, 'Payment not confirmed yet');

        await footage.closePage(checkout, 'Close the checkout');
        await footage.tap(page.getByTestId('premium-abandon'), 'Start over');
        await expect(page.getByTestId('premium-buy')).toBeVisible();
        await expect(status).toHaveCount(0);
        await expect(page.getByTestId('premium-message')).toHaveCount(0);
        expect(await readPendingInvoice(page), 'Start over did not forget the invoice').toBeNull();
        await footage.result(page, 'Invoice abandoned');

        await reopenFeed(page, footage);
        await expect(page.getByTestId('premium-buy')).toBeVisible();
        await expect(status).toHaveCount(0);
        await footage.settled(page, 'Plan picker after abandoning');
      }
    });

    test('an invoice the backend does not know is refused and automatic checking stops', async ({ live, footage }) => {
      test.setTimeout(45 * 60_000);
      test.skip(skipDestructiveOnShared(), 'asks the production backend to activate; set ALLOW_PROD_WRITES=1');
      await premiumOrSkip();
      const wallet = await live.get(BROWSE);
      const page = wallet.page;
      footage.mark('Refusal of an unknown invoice', wallet.name);
      await openFeed(page, footage);
      test.skip((await feedPostingState(page)) === 'composer', `${wallet.name} can already post, so no purchase screen is offered`);
      await planPicker(page, footage);

      // The wallet remembers an invoice the backend never minted, as after a
      // server restore or a stale profile. The activation request is real.
      const synthetic = `e2e-unknown-${randomBytes(6).toString('hex')}`;
      await rememberInvoice(page, {
        invoiceId: synthetic,
        planId: 'founding',
        rail: 'btcpay',
        payTo: `${run.checkoutOrigin ?? 'https://checkout.invalid'}/i/${synthetic}`,
        // The wallet only offers an invoice minted on the backend it talks to.
        apiBase: run.apiBase ?? BACKEND_URL.replace(/\/$/, ''),
        createdAt: Date.now(),
      });
      const asked: number[] = [];
      const count = (request: { method(): string; url(): string }) => {
        if (request.method() === 'POST' && request.url().endsWith('/premium/activate')) asked.push(Date.now());
      };
      page.on('request', count);
      try {
        await reopenFeed(page, footage);
        await expect(page.getByTestId('premium-auto-status'), 'the remembered invoice was not offered').toContainText(AUTO_RUNNING);
        await expect(page.getByTestId('premium-message')).toContainText(SAYS.unknown, { timeout: 60_000 });
        await expect(page.getByTestId('premium-auto-status'), 'a final refusal must stop automatic checking').toHaveCount(0);
        expect(asked.length, 'expected exactly one automatic activation attempt').toBe(1);
        await footage.result(page, 'Unknown invoice refused');
        // A fixed watch of more than two poll periods, recorded or not: nothing else is asked.
        await footage.observe(page, QUIET_WATCH_MS, 'No further automatic checks');
        expect(asked.length, 'automatic checking continued after a final refusal').toBe(1);

        // On demand it still asks, and gets the same answer.
        await checkNow(page, footage, SAYS.unknown);
        expect(asked.length).toBeGreaterThanOrEqual(2);
        await footage.result(page, 'Check now refused the same way');
      } finally {
        page.off('request', count);
      }
      await footage.tap(page.getByTestId('premium-abandon'), 'Start over');
      await expect(page.getByTestId('premium-buy')).toBeVisible();
      expect(await readPendingInvoice(page)).toBeNull();
      await footage.settled(page, 'Refused invoice cleared');
    });

    if (PURCHASE) {
      test(`${PURCHASE.wallet} buys the cheapest plan in LTC; one window activates, the other is refused as used`, async ({ live, footage }) => {
        test.setTimeout(3 * 60 * 60_000);
        test.skip(skipDestructiveOnShared(), 'pays a real invoice on a shared backend; set ALLOW_PROD_WRITES=1');
        const { caps, currency, plans } = await premiumOrSkip();
        expect(currency, 'the price checks below are in USD').toBe('USD');
        const cheapest = cheapestPlan(plans);
        const planUsd = Number(cheapest.amount);
        expect(planUsd, 'the cheapest plan costs more than G_PREMIUM_MAX_USD').toBeLessThanOrEqual(PURCHASE.maxPlanUsd);
        footage.evidence('purchased_plan', cheapest.id);
        const buyer = await live.get(PURCHASE.wallet);
        const page = buyer.page;
        footage.mark('Premium purchase in Litecoin', buyer.name);

        await openFeed(page, footage);
        test.skip((await feedPostingState(page)) === 'composer', `${buyer.name} can already post (premium active or write allowlist), `
          + 'so no purchase screen is offered; set G_PREMIUM_PURCHASE_WALLET to a wallet without premium');

        // Funds first, before an invoice takes one of the wallet's eight slots.
        // The Home row is cut to 4 decimals, so it can only understate.
        await goHome(page, footage);
        const before = await waitForAssetBalance(page, 'ltc');
        const price = before.amount > 0 && before.usd ? before.usd / before.amount : null;
        const roughNeed = price ? planUsd / price * 1.05 + 0.002 : 0.002;
        test.skip(before.amount < roughNeed, `${buyer.name} holds about ${before.amount} LTC, less than the plan (about ${roughNeed.toFixed(4)} LTC) plus fees`);
        await footage.result(page, 'Litecoin balance before the purchase');
        // Full precision, for the record.
        await footage.tap(page.getByTestId('asset-row-ltc'), 'Open Litecoin');
        const exactBefore = await waitForDetailBalance(page);
        footage.evidence('ltc_confirmed_before', exactBefore);
        await footage.result(page, 'Litecoin detail before the purchase');
        await footage.tap(page.getByTestId('asset-detail-back'), 'Back to Home');
        await footage.settled(page, 'Home before the purchase');

        await openFeed(page, footage);
        await planPicker(page, footage);
        await footage.tap(page.getByTestId(`premium-plan-${cheapest.id}`), 'Choose the cheapest plan');
        await expect(page.getByTestId(`premium-plan-${cheapest.id}`)).toHaveAttribute('aria-checked', 'true');
        await footage.settled(page, 'Cheapest plan chosen');
        await chooseBtcpay(page, footage, caps);
        const checkout = await mint(buyer, page, footage);
        const pending = await readPendingInvoice(page);
        expect(pending?.planId).toBe(cheapest.id);
        expect(pending?.rail).toBe('btcpay');
        await expectCheckoutFor(checkout, pending!.invoiceId, pending!.payTo);
        footage.evidence('paid_invoice', pending!.invoiceId);
        await footage.settled(checkout, 'Checkout loaded');

        // Pinned host, and the page and the checkout's own status agree.
        const request = await readLitecoinRequest(checkout, footage, pending!.invoiceId, PURCHASE.checkoutHost);
        const due = toLitoshi(request.amount);
        expect(isLitecoinAddress(request.address)).toBe(true);
        expect(due > 0n).toBe(true);
        expect(due <= toLitoshi(PURCHASE.maxLtc), 'the checkout asks more than G_PREMIUM_MAX_LTC').toBe(true);
        if (price) {
          const usd = Number(request.amount) * price;
          expect(usd, 'the LTC asked is far from the plan price').toBeGreaterThan(planUsd * 0.75);
          expect(usd, 'the LTC asked is far from the plan price').toBeLessThan(planUsd * 1.35);
        }
        footage.evidence('ltc_due', request.amount);
        await footage.result(checkout, 'Checkout asks for Litecoin');
        await page.bringToFront();
        await footage.settled(page, 'Invoice waiting for payment');
        if (BigInt(Math.floor(before.amount * 1e8)) < due + 200_000n) {
          await footage.closePage(checkout, 'Close the checkout');
          await footage.tap(page.getByTestId('premium-abandon'), 'Start over');
          await expect(page.getByTestId('premium-buy')).toBeVisible();
          await footage.settled(page, 'Invoice abandoned for lack of funds');
          test.skip(true, `${buyer.name} holds about ${before.amount} LTC, less than the ${request.amount} LTC due plus fees`);
        }

        // Two windows wait on this invoice and stay on it until it settles:
        // whichever checks first redeems it, and the other is refused as
        // "already used". The payment goes from a third window, so neither
        // waiting window ever leaves the pending screen.
        const second = await buyer.openWindow(`${buyer.name}-second-window`);
        await footage.settled(second, 'Second window unlocked');
        await openFeed(second, footage);
        await expect(second.getByTestId('premium-auto-status')).toContainText(AUTO_RUNNING);
        await expect(second.getByTestId('premium-checkout-link')).toHaveAttribute('href', pending!.payTo);
        await footage.result(second, 'Second window waits on the same invoice');

        const answers = new Map<Page, Array<{ status: number; body: string; at: number }>>([[page, []], [second, []]]);
        for (const [window, list] of answers) {
          window.on('response', (res) => {
            if (!res.url().endsWith('/premium/activate') || res.request().method() !== 'POST') return;
            const at = Date.now();
            void res.text().then((body) => list.push({ status: res.status(), body, at }), () => list.push({ status: res.status(), body: '', at }));
          });
        }

        // Pay from a third window: Home, Send, Litecoin, the checkout's address
        // and exact amount.
        const pay = await buyer.openWindow(`${buyer.name}-pay-window`);
        footage.mark('Paying the checkout', buyer.name);
        await footage.settled(pay, 'Payment window ready');
        await footage.tap(pay.getByTestId('home-action-send'), 'Send');
        const asset = pay.getByTestId('send-asset-ltc');
        const address = pay.getByTestId('send-address-input');
        await expect(asset.or(address)).toBeVisible({ timeout: 30_000 });
        if (await asset.isVisible()) {
          await footage.settled(pay, 'Choose what to send');
          await footage.tap(asset, 'Choose Litecoin');
          await expect(address).toBeVisible({ timeout: 30_000 });
        }
        await footage.settled(pay, 'Recipient entry');
        await footage.type(address, request.address, 'Enter the checkout address');
        await footage.tap(pay.getByTestId('send-address-continue'), 'Continue to the amount');
        await expect(pay.getByTestId('send-amount-input')).toBeVisible({ timeout: 30_000 });
        await footage.settled(pay, 'Amount entry');
        await footage.type(pay.getByTestId('send-amount-input'), request.amount, 'Enter the amount due');
        await footage.settled(pay, 'Fee estimate loaded');
        await footage.tap(pay.getByTestId('send-compose-continue'), 'Review the payment');
        const review = pay.locator('#root');
        await expect(review).toContainText(request.address);
        const shown = /Amount\s*([\d.,]+)\s*LTC/.exec(await review.innerText());
        expect(shown, 'the review shows no LTC amount').not.toBeNull();
        expect(toLitoshi(shown![1]!.replace(/,/g, '')), 'the review amount differs from the amount due').toBe(due);
        await footage.result(pay, 'Payment reviewed');

        const asked = pay.getByTestId('operation-password');
        const done = pay.getByTestId('send-done-txid');
        await footage.tap(pay.getByTestId('send-review-submit'), 'Send the payment');
        await expect(asked.or(done)).toBeVisible({ timeout: 180_000 });
        if (await asked.isVisible()) {
          await buyer.confirmOperationPassword(pay);
          await expect(done).toBeVisible({ timeout: 180_000 });
        }
        const txid = ((await done.textContent()) ?? '').trim();
        expect(txid, 'the send did not return a transaction id').toMatch(/^[0-9a-f]{64}$/);
        footage.evidence('premium_ltc_txid', txid);
        // The receipt closes itself after 12 s, so this one tap comes first and
        // its pause after (a recorded policy exception). If the receipt is gone
        // already, nothing is lost: the payment is read back from history below.
        const kept = await footage.tapThenHold(pay.getByRole('button', { name: 'Stay on this screen' }), 'Keep the receipt on screen');
        footage.evidence('receipt_kept_on_screen', kept);
        if (kept) {
          await footage.result(pay, 'Litecoin payment broadcast');
          await footage.tap(pay.getByTestId('send-done-close'), 'Done');
        }
        await expect(done).toHaveCount(0, { timeout: 30_000 });
        await footage.settled(pay, 'Home after the payment');

        // The checkout acknowledges the payment. Its wording is the processor's
        // own, so this is evidence, not the assertion: activation below is.
        await checkout.bringToFront();
        const acknowledged = await checkout.getByText(/invoice paid|payment received|paid successfully|invoice settled/i)
          .first().waitFor({ timeout: 20 * 60_000 }).then(() => true, () => false);
        footage.evidence('checkout_acknowledged', acknowledged);
        await footage.result(checkout, 'Checkout sees the payment');

        // Wait for settlement in fixed one-minute rounds, recorded or not. Both
        // waiting windows check on their own for the first hour; past it, each
        // gets at most one Check now per LTC block.
        footage.mark('Waiting for the payment to settle', buyer.name);
        const activated = () => [...answers].find(([, list]) => list.some((a) => a.status === 200 && /"active"\s*:\s*true/.test(a.body)))?.[0];
        const deadline = Date.now() + 150 * 60_000;
        const rotation = [page, second, checkout];
        const lastManual = new Map<Page, number>();
        for (let round = 0; !activated(); round++) {
          if (Date.now() > deadline) throw new Error('The invoice never activated premium within 150 minutes of payment.');
          const window = rotation[round % rotation.length]!;
          if (window !== checkout) {
            const status = (await window.getByTestId('premium-auto-status').textContent({ timeout: 5_000 }).catch(() => null)) ?? '';
            if (AUTO_STOPPED.test(status) && Date.now() - (lastManual.get(window) ?? 0) >= MANUAL_CHECK_EVERY_MS) {
              lastManual.set(window, Date.now());
              await footage.tap(window.getByTestId('premium-redeem'), 'Check now');
            }
          }
          await footage.observe(window, SETTLE_ROUND_MS, 'Waiting for a confirmation');
        }
        const winner = activated()!;
        const loser = winner === page ? second : page;
        footage.evidence('activated_in', winner === page ? 'first window' : 'second window');

        // The grant: one plan period from activation (premium had lapsed or never begun).
        const granted = answers.get(winner)!.find((a) => a.status === 200 && /"active"\s*:\s*true/.test(a.body))!;
        const until = premiumUntilOf(granted.body);
        expect(until, 'the activation answer carries no premium_until').not.toBeNull();
        expect(Math.abs(until! - (granted.at + cheapest.days * DAY_MS)), 'premium_until is not one plan period after activation')
          .toBeLessThanOrEqual(DAY_MS);
        footage.evidence('premium_until', new Date(until!).toISOString());

        // The window that redeemed it turns premium on and offers the composer.
        await expect(winner.getByTestId('feed-compose'), 'premium is active but the composer is not offered').toBeVisible({ timeout: 90_000 });
        await expect(winner.getByTestId('feed-compose')).toBeEnabled({ timeout: 90_000 });
        await expect(winner.getByTestId('feed-needs-premium')).toHaveCount(0);
        await footage.result(winner, 'Premium is active and the composer is enabled');

        // The other window's next check is refused: the invoice is single-use.
        const loserStatus = loser.getByTestId('premium-auto-status');
        if (AUTO_STOPPED.test((await loserStatus.textContent({ timeout: 5_000 }).catch(() => null)) ?? '')) {
          await footage.tap(loser.getByTestId('premium-redeem'), 'Check now');
        }
        await expect(loser.getByTestId('premium-message')).toContainText(SAYS.used, { timeout: 5 * 60_000 });
        await expect(loserStatus, 'a used invoice must stop automatic checking').toHaveCount(0);
        await expect.poll(() => answers.get(loser)!.some((a) => a.status === 400 && SAYS.used.test(a.body)), {
          timeout: 30_000,
          message: 'the backend did not answer the other window with "already used"',
        }).toBe(true);
        await footage.result(loser, 'Other window refused the used invoice');
        await reopenFeed(loser, footage);
        await expect(loser.getByTestId('feed-compose'), 'the other window does not see premium after reloading').toBeVisible({ timeout: 90_000 });
        await footage.settled(loser, 'Other window now offers the composer');
        expect(await readPendingInvoice(page), 'the redeemed invoice is still remembered').toBeNull();

        // Posting is public and permanent: only with the owner's approval.
        await winner.bringToFront();
        const compose = winner.getByTestId('feed-compose');
        await expect(compose).toBeEnabled();
        if (!PURCHASE.postApproved) {
          await expect(winner.getByTestId('feed-post'), 'Post must stay disabled while the composer is empty').toBeDisabled();
          test.info().annotations.push({ type: 'not-run', description: 'Posting needs owner approval (E2E_PREMIUM_POST=1).' });
          await footage.result(winner, 'Composer ready, posting not approved');
        } else {
          footage.mark('Premium post to the feed', buyer.name);
          await footage.type(compose, NOTE_TEXT, 'Write a post');
          await footage.tap(winner.getByTestId('feed-post'), 'Post');
          const signing = winner.getByTestId('operation-password');
          if (await signing.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await buyer.confirmOperationPassword(winner);
          await expect(winner.getByTestId('feed-note').filter({ hasText: NOTE_TEXT }).first()).toBeVisible({ timeout: 90_000 });
          await footage.result(winner, 'Post published');
          await footage.tap(winner.getByTestId('feed-refresh'), 'Refresh the feed');
          await expect(winner.getByTestId('feed-note').filter({ hasText: NOTE_TEXT }).first(), 'the relay did not serve the post back').toBeVisible({ timeout: 90_000 });
          await footage.result(winner, 'Post served back by the relay');
        }

        // The payment, read back from the wallet: the LTC history lists it by
        // its txid, and its detail opens. The balance is evidence only: other
        // lanes move funds among the demo wallets while this one runs.
        footage.mark('Payment in the Litecoin history', buyer.name);
        await pay.bringToFront();
        await goHome(pay, footage);
        const row = activityRow(pay, txid);
        let listed = false;
        for (let look = 0; look < 10 && !listed; look++) {
          if (look > 0) {
            await footage.tap(pay.getByTestId('asset-detail-back'), 'Back to Home');
            await footage.settled(pay, 'Home before looking again');
          }
          await footage.tap(pay.getByTestId('asset-row-ltc'), 'Open Litecoin');
          await expect(pay.getByTestId('asset-detail-balance')).toBeVisible({ timeout: 60_000 });
          listed = await row.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false);
          if (!listed) await footage.observe(pay, SETTLE_ROUND_MS, 'Waiting for the history to list the payment');
        }
        expect(listed, 'the payment never appeared in the LTC history by its transaction id').toBe(true);
        await footage.settled(pay, 'Litecoin activity');
        await footage.tap(rowOpener(row), 'Open the payment');
        const sheet = pay.getByTestId('tx-detail-sheet');
        await expect(sheet).toBeVisible({ timeout: 30_000 });
        await expect(sheet, 'the history detail does not name this transaction').toContainText(txid);
        await expect(sheet).toContainText('Sent');
        footage.evidence('history_names_checkout_address', (await sheet.innerText()).includes(request.address));
        await footage.result(pay, 'Payment in the history');
        await footage.tap(pay.getByTestId('tx-detail-close'), 'Close the payment');
        await footage.settled(pay, 'Litecoin activity after the payment');
        const exactAfter = await waitForDetailBalance(pay);
        footage.evidence('ltc_confirmed_after', exactAfter);
        footage.evidence('ltc_dropped_by_at_least_due', toLitoshi(exactBefore) - toLitoshi(exactAfter) >= due);
        await footage.result(pay, 'Litecoin balance after the purchase');
        await footage.tap(pay.getByTestId('asset-detail-back'), 'Back to Home');
        await footage.settled(pay, 'Home after the purchase');

        await footage.closePage(checkout, 'Close the checkout');
        await footage.closePage(pay, 'Close the payment window');
        await footage.closePage(second, 'Close the second window');
      });
    }
  });
}
