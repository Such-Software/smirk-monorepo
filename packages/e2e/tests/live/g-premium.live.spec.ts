/**
 * G-premium (live, production): premium plans, invoices and automatic checking
 * on the v0.3.1 release candidate, driven through the real wallet UI.
 *
 *   1. Plans are named from their ids, because the backend sends no labels:
 *      "Founding member" ($5) and "Standard" ($15), on one rail, btcpay
 *      (BTC, LTC, GRIN).
 *   2. Each plan mints an invoice whose checkout opens the owner's BTCPay page;
 *      the automatic check ticks every 15 s; Check now gets the server's "not
 *      yet confirmed"; Start over abandons it. The invoice survives leaving the
 *      screen; the abandon survives it too.
 *   3. Refusal: an invoice the backend does not know is refused once, and
 *      automatic checking stops. (The "already used" refusal is reproduced in 4,
 *      the only place a real used invoice exists.)
 *   4. Optional, flagged: alice pays the founding plan in LTC to the invoice's
 *      checkout address, from a third window. Of the two alice windows waiting
 *      on the invoice, one activates premium and gets the composer; the other
 *      is refused with "already used". Posting needs the owner's separate
 *      approval.
 *
 * Gates, each its own opt-in (names only; no values on command lines):
 *   E2E_LIVE=1             declare these tests at all (the default suite never sees them)
 *   ALLOW_PROD_WRITES=1    mint real invoices on a shared backend (2, 3 and 4)
 *   E2E_LIVE_MONEY=1 and E2E_PREMIUM_PURCHASE=1   pay the founding plan from alice (4)
 *   E2E_PREMIUM_POST=1     owner approval to publish one public note after activation
 *   G_PREMIUM_BROWSE_WALLET=carol|bob   the wallet that mints and abandons (default carol)
 *   G_PREMIUM_MAX_LTC      refuse to pay a checkout asking more (default 0.12 LTC)
 *   G_PREMIUM_CHECKOUT_HOST    when set, the checkout must open on exactly this host
 *   FOOTAGE=guarded        record through the guarded recorder (fixtures/G-premium-footage.ts)
 *
 * The backend counts every unpaid premium invoice against a cap of eight per
 * account and never expires them, so each run of scenario 2 permanently uses
 * two of the browsing wallet's eight. Scenario 2 skips with that cause when the
 * cap is reached; switch G_PREMIUM_BROWSE_WALLET or clear the rows.
 *
 * Run from packages/e2e (the custody file is read in-process, never sourced):
 *   E2E_LIVE=1 ALLOW_PROD_WRITES=1 FOOTAGE=guarded E2E_MIN_EXECUTED=1 \
 *   BACKEND_URL=https://api.smirk.cash/api/v1 EXTENSION_DIST=<unpacked staged chrome zip> \
 *   LIVE_WALLET_FILE=<main checkout>/packages/smoke-tests/secrets/smoke-mnemonics.env \
 *   npx playwright test tests/live/g-premium.live.spec.ts
 * Then encode: node scripts/G-premium-footage.mjs --run <footage run directory>
 */

import { randomBytes } from 'node:crypto';
import type { Page, Response } from '@playwright/test';
import { test, expect, LIVE, type LiveWallet, type WalletName } from '../../fixtures/G-premium-wallets.js';
import { BACKEND_URL, skipDestructiveOnShared } from '../../fixtures/extension.js';
import type { GuardedFootage } from '../../fixtures/G-premium-footage.js';
import {
  expectedPlanLabel,
  feedPostingState,
  isLitecoinAddress,
  observeAutoChecks,
  premiumCapabilities,
  readAssetBalance,
  readLitecoinRequest,
  readPendingInvoice,
  rememberInvoice,
  tabRoot,
  toLitoshi,
  type PremiumCaps,
  type PremiumPlan,
} from '../../fixtures/G-premium-checkout.js';

const BROWSE: WalletName = process.env.G_PREMIUM_BROWSE_WALLET === 'bob' ? 'bob' : 'carol';
const PURCHASE = process.env.E2E_LIVE_MONEY === '1' && process.env.E2E_PREMIUM_PURCHASE === '1';
const POST_APPROVED = process.env.E2E_PREMIUM_POST === '1';
const MAX_LTC = process.env.G_PREMIUM_MAX_LTC ?? '0.12';
const CHECKOUT_HOST = process.env.G_PREMIUM_CHECKOUT_HOST?.trim() || null;

/** The release review's expectations for the plans the backend advertises. */
const RELEASE_PLANS: Readonly<Record<string, { name: string; amount: string }>> = {
  founding: { name: 'Founding member', amount: '5' },
  year: { name: 'Standard', amount: '15' },
};

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

/** Shared between the serial tests of one run (one worker). */
const run: { apiBase?: string; checkoutOrigin?: string } = {};

async function premiumOrSkip(): Promise<{ caps: PremiumCaps; currency: string; plans: PremiumPlan[] }> {
  const caps = await premiumCapabilities();
  test.skip(!caps.features.premium_relay || !caps.premium, 'the backend does not advertise premium_relay with plans');
  test.skip(!caps.features.feed, 'the backend advertises no feed, so the wallet has no purchase screen');
  return { caps, currency: caps.premium!.currency, plans: caps.premium!.plans };
}

function plan(plans: PremiumPlan[], id: string): PremiumPlan {
  const found = plans.find((p) => p.id === id);
  if (!found) throw new Error(`The backend no longer advertises the ${id} plan.`);
  return found;
}

/** Open the Feed on this window and let it settle. */
async function openFeed(page: Page, footage: GuardedFootage): Promise<void> {
  await tabRoot(page, footage, 'feed', 'Open the Feed');
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 60_000 });
  await footage.settled(page, 'Feed settled');
}

/** Leave the Feed and come back, so the purchase screen reloads its state. */
async function reopenFeed(page: Page, footage: GuardedFootage): Promise<void> {
  await tabRoot(page, footage, 'home', 'Leave the Feed');
  await tabRoot(page, footage, 'feed', 'Return to the Feed');
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 60_000 });
}

/** The plan picker, clearing a remembered invoice an interrupted run left behind. */
async function planPicker(page: Page, footage: GuardedFootage): Promise<void> {
  const buy = page.getByTestId('premium-buy');
  const leftover = page.getByTestId('premium-abandon');
  await expect(buy.or(leftover)).toBeVisible({ timeout: 60_000 });
  if (await leftover.isVisible()) await footage.tap(leftover, 'Start over on a leftover invoice');
  await expect(buy).toBeVisible({ timeout: 30_000 });
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
    test.skip(true, `${wallet.name} has eight unpaid premium invoices, the backend cap; it never expires them `
      + '(count_unconsumed_premium_invoices has no age bound). Use G_PREMIUM_BROWSE_WALLET or clear the rows.');
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
  if (CHECKOUT_HOST) expect(opened.host, 'the checkout is not on the owner BTCPay host').toBe(CHECKOUT_HOST);
  if (run.checkoutOrigin) expect(opened.origin, 'two plans opened checkouts on different hosts').toBe(run.checkoutOrigin);
  await expect(tab.locator('body'), 'the checkout page shows no payment methods').toContainText(/\b(BTC|LTC|Bitcoin|Litecoin)\b/, { timeout: 90_000 });
  return opened;
}

if (LIVE) {
  test.describe('G-premium: premium plans, invoices and automatic checking', () => {
    test.describe.configure({ mode: 'serial' });

    test('plans are named from their ids on the single btcpay rail', async ({ live, footage }) => {
      test.setTimeout(45 * 60_000);
      const { caps, currency, plans } = await premiumOrSkip();

      // The backend sends ids only; the wallet must name them.
      for (const p of plans) expect(p.label, `the ${p.id} plan now carries a backend label`).toBeUndefined();
      for (const [id, release] of Object.entries(RELEASE_PLANS)) {
        const advertised = plan(plans, id);
        expect(advertised.amount, `the ${id} price differs from the v0.3.1 release scenario`).toBe(release.amount);
        expect(advertised.days).toBe(365);
      }
      expect(currency).toBe('USD');
      const rails = caps.premium!.rails ?? [];
      expect(rails.map((r) => r.id), 'expected exactly one rail, btcpay').toEqual(['btcpay']);
      expect([...rails[0]!.assets].sort()).toEqual(['BTC', 'GRIN', 'LTC']);

      const wallet = await live.get(BROWSE);
      const page = wallet.page;
      footage.mark('Premium plans named from their ids', wallet.name);
      await footage.settled(page, 'Wallet ready');
      await openFeed(page, footage);
      const state = await feedPostingState(page);
      test.skip(state === 'composer', `${wallet.name} can already post (premium or write allowlist), so no purchase screen is offered`);
      await expect(page.getByTestId('feed-needs-premium')).toContainText('Posting to this feed needs a premium subscription');
      await planPicker(page, footage);

      const founding = page.getByTestId('premium-plan-founding');
      const year = page.getByTestId('premium-plan-year');
      expect(expectedPlanLabel(plan(plans, 'founding'), currency)).toBe('Founding member, 1 year, 5 USD');
      expect(expectedPlanLabel(plan(plans, 'year'), currency)).toBe('Standard, 1 year, 15 USD');
      for (const p of plans) {
        await expect(page.getByTestId(`premium-plan-${p.id}`)).toHaveText(expectedPlanLabel(p, currency));
      }
      await expect(page.locator('[role="radio"][data-testid^="premium-plan-"]')).toHaveCount(plans.length);
      await expect(founding, 'the first plan is chosen by default').toHaveAttribute('aria-checked', 'true');
      await expect(year).toHaveAttribute('aria-checked', 'false');
      // One rail: named by its assets, with no rail choice to make.
      await expect(page.getByTestId('premium-rail-single')).toHaveText('Pays in BTC · LTC · GRIN');
      await expect(page.locator('[data-testid^="premium-rail-"]:not([data-testid="premium-rail-single"])')).toHaveCount(0);
      await expect(page.getByTestId('premium-buy')).toHaveText('Get premium');
      await expect(page.getByTestId('premium-buy')).toBeEnabled();
      await footage.result(page, 'Founding member and Standard plans');

      await footage.tap(year, 'Choose the Standard plan');
      await expect(year).toHaveAttribute('aria-checked', 'true');
      await expect(founding).toHaveAttribute('aria-checked', 'false');
      await footage.result(page, 'Standard plan chosen');
      await footage.tap(founding, 'Choose the Founding member plan');
      await expect(founding).toHaveAttribute('aria-checked', 'true');
      await footage.settled(page, 'Founding member plan chosen');
    });

    test('each plan mints a btcpay invoice that auto-checks, checks now and is abandoned', async ({ live, footage }) => {
      test.setTimeout(90 * 60_000);
      test.skip(skipDestructiveOnShared(), 'mints real BTCPay invoices on a shared backend; set ALLOW_PROD_WRITES=1');
      const { currency, plans } = await premiumOrSkip();
      const wallet = await live.get(BROWSE);
      const page = wallet.page;
      await openFeed(page, footage);
      test.skip((await feedPostingState(page)) === 'composer', `${wallet.name} can already post, so no purchase screen is offered`);

      for (const id of ['founding', 'year']) {
        const chosen = plan(plans, id);
        footage.mark(id === 'founding' ? 'Founding member invoice' : 'Standard invoice', wallet.name);
        await planPicker(page, footage);
        await footage.tap(page.getByTestId(`premium-plan-${id}`), id === 'founding' ? 'Choose the Founding member plan' : 'Choose the Standard plan');
        await expect(page.getByTestId(`premium-plan-${id}`)).toHaveAttribute('aria-checked', 'true');
        await expect(page.getByTestId(`premium-plan-${id}`)).toHaveText(expectedPlanLabel(chosen, currency));

        const checkout = await mint(wallet, page, footage);
        const pending = await readPendingInvoice(page);
        expect(pending, 'the wallet did not remember the invoice before opening the checkout').not.toBeNull();
        expect(pending!.planId).toBe(id);
        expect(pending!.rail).toBe('btcpay');
        expect(new URL(pending!.apiBase).host, 'the invoice is bound to another backend').toBe(new URL(BACKEND_URL).host);
        const opened = await expectCheckoutFor(checkout, pending!.invoiceId, pending!.payTo);
        run.checkoutOrigin = opened.origin;
        run.apiBase = pending!.apiBase;
        footage.evidence(`unpaid_invoice_${id}`, pending!.invoiceId);
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
        // Two poll periods and more: nothing else is asked.
        await footage.settled(page, 'No further automatic checks');
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

    test('alice buys the founding plan in LTC; one window activates, the other is refused as used', async ({ live, footage }) => {
      test.setTimeout(3 * 60 * 60_000);
      test.skip(!PURCHASE, 'real purchase is flagged off; set E2E_LIVE_MONEY=1 and E2E_PREMIUM_PURCHASE=1');
      test.skip(skipDestructiveOnShared(), 'pays a real invoice on a shared backend; set ALLOW_PROD_WRITES=1');
      const { plans } = await premiumOrSkip();
      const founding = plan(plans, 'founding');
      const planUsd = Number(founding.amount);
      const alice = await live.get('alice');
      const page = alice.page;
      footage.mark('Founding member purchase in Litecoin', 'alice');

      await openFeed(page, footage);
      test.skip((await feedPostingState(page)) === 'composer', 'alice can already post (premium active or write allowlist); the purchase screen is not offered');

      // Funds first, before an invoice spends one of alice's eight.
      await tabRoot(page, footage, 'home', 'Go to Home');
      await footage.settled(page, 'Home before the purchase');
      const before = await readAssetBalance(page, 'ltc');
      expect(before.amount, 'no LTC balance rendered for alice').not.toBeNull();
      const price = before.amount && before.usd ? before.usd / before.amount : null;
      const roughNeed = price ? planUsd / price * 1.05 + 0.002 : 0.002;
      test.skip(before.amount! < roughNeed, `alice holds ${before.amount} LTC, less than the founding plan (about ${roughNeed.toFixed(4)} LTC) plus fees`);
      footage.evidence('alice_ltc_before', before.amount!);
      await footage.result(page, 'Alice Litecoin balance before');

      await openFeed(page, footage);
      await planPicker(page, footage);
      await footage.tap(page.getByTestId('premium-plan-founding'), 'Choose the Founding member plan');
      const checkout = await mint(alice, page, footage);
      const pending = await readPendingInvoice(page);
      expect(pending?.planId).toBe('founding');
      await expectCheckoutFor(checkout, pending!.invoiceId, pending!.payTo);
      footage.evidence('paid_invoice', pending!.invoiceId);
      await footage.settled(checkout, 'Checkout loaded');

      const request = await readLitecoinRequest(checkout, footage, pending!.invoiceId);
      const due = toLitoshi(request.amount);
      expect(isLitecoinAddress(request.address)).toBe(true);
      expect(due > 0n).toBe(true);
      expect(due <= toLitoshi(MAX_LTC), `the checkout asks more than G_PREMIUM_MAX_LTC (${MAX_LTC} LTC)`).toBe(true);
      if (price) {
        const usd = Number(request.amount) * price;
        expect(usd, 'the LTC asked is far from the plan price').toBeGreaterThan(planUsd * 0.75);
        expect(usd, 'the LTC asked is far from the plan price').toBeLessThan(planUsd * 1.35);
      }
      const balance = BigInt(Math.round(before.amount! * 1e8));
      if (balance < due + 200_000n) {
        await footage.tap(page.getByTestId('premium-abandon'), 'Start over');
        test.skip(true, `alice holds ${before.amount} LTC, less than the ${request.amount} LTC due plus fees`);
      }
      footage.evidence('ltc_due', request.amount);
      await footage.result(checkout, 'Checkout asks for Litecoin');

      // Two alice windows wait on this invoice and stay on it until it
      // settles: whichever checks first redeems it, and the other is refused
      // as "already used". The payment goes from a third window, so neither
      // waiting window ever leaves the pending screen.
      const second = await alice.openWindow('alice-second-window');
      await openFeed(second, footage);
      await expect(second.getByTestId('premium-auto-status')).toContainText(AUTO_RUNNING);
      await expect(second.getByTestId('premium-checkout-link')).toHaveAttribute('href', pending!.payTo);
      await footage.result(second, 'Second window waits on the same invoice');

      const answers = new Map<Page, Array<{ status: number; body: string }>>([[page, []], [second, []]]);
      for (const [window, list] of answers) {
        window.on('response', (res) => {
          if (!res.url().endsWith('/premium/activate') || res.request().method() !== 'POST') return;
          void res.text().then((body) => list.push({ status: res.status(), body }), () => list.push({ status: res.status(), body: '' }));
        });
      }

      // Pay from a third window: Home, Send, Litecoin, the checkout's address
      // and exact amount.
      const pay = await alice.openWindow('alice-pay-window');
      footage.mark('Paying the checkout from alice', 'alice');
      await footage.settled(pay, 'Payment window ready');
      await footage.tap(pay.getByTestId('home-action-send'), 'Send');
      const asset = pay.getByTestId('send-asset-ltc');
      const address = pay.getByTestId('send-address-input');
      await expect(asset.or(address)).toBeVisible({ timeout: 30_000 });
      if (await asset.isVisible()) await footage.tap(asset, 'Choose Litecoin');
      await footage.type(address, request.address, 'Enter the checkout address');
      await footage.tap(pay.getByTestId('send-address-continue'), 'Continue to the amount');
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
        await alice.confirmOperationPassword(pay);
        await expect(done).toBeVisible({ timeout: 180_000 });
      }
      const txid = ((await done.textContent()) ?? '').trim();
      expect(txid, 'the send did not return a transaction id').toMatch(/^[0-9a-f]{64}$/);
      footage.evidence('premium_ltc_txid', txid);
      const stay = pay.getByRole('button', { name: 'Stay on this screen' });
      if (await stay.isVisible()) await footage.tap(stay, 'Keep the receipt on screen');
      await footage.result(pay, 'Litecoin payment broadcast');
      await footage.tap(pay.getByTestId('send-done-close'), 'Done');

      // The checkout acknowledges the payment. Its wording is the processor's
      // own, so this is evidence, not the assertion: activation below is.
      await checkout.bringToFront();
      const acknowledged = await checkout.getByText(/invoice paid|payment received|paid successfully|invoice settled/i)
        .first().waitFor({ timeout: 20 * 60_000 }).then(() => true, () => false);
      footage.evidence('checkout_acknowledged', acknowledged);
      await footage.result(checkout, 'Checkout sees the payment');

      // Wait for settlement; both waiting windows keep checking on their own.
      footage.mark('Waiting for the payment to settle', 'alice');
      await page.bringToFront();
      const activated = () => [...answers].find(([, list]) => list.some((a) => a.status === 200 && /"active"\s*:\s*true/.test(a.body)))?.[0];
      const deadline = Date.now() + 150 * 60_000;
      for (let round = 0; !activated(); round++) {
        if (Date.now() > deadline) throw new Error('The invoice never activated premium within 150 minutes of payment.');
        for (const window of answers.keys()) {
          const status = (await window.getByTestId('premium-auto-status').textContent().catch(() => null)) ?? '';
          // Automatic checking ends an hour after minting; past that, ask on demand.
          if (AUTO_STOPPED.test(status)) await footage.tap(window.getByTestId('premium-redeem'), 'Check now');
        }
        // The window lane alternates between the second waiting window and the checkout.
        await footage.result(round % 2 ? checkout : second, 'Waiting for a confirmation');
      }
      const winner = activated()!;
      const loser = winner === page ? second : page;
      footage.evidence('activated_in', winner === page ? 'first window' : 'second window');

      // The window that redeemed it turns premium on and offers the composer.
      await expect(winner.getByTestId('feed-compose'), 'premium is active but the composer is not offered').toBeVisible({ timeout: 90_000 });
      await expect(winner.getByTestId('feed-compose')).toBeEnabled({ timeout: 90_000 });
      await expect(winner.getByTestId('feed-needs-premium')).toHaveCount(0);
      await footage.result(winner, 'Premium is active and the composer is enabled');

      // The other window's next check is refused: the invoice is single-use.
      const loserStatus = loser.getByTestId('premium-auto-status');
      if (AUTO_STOPPED.test((await loserStatus.textContent().catch(() => null)) ?? '')) {
        await footage.tap(loser.getByTestId('premium-redeem'), 'Check now');
      }
      await expect(loser.getByTestId('premium-message')).toContainText(SAYS.used, { timeout: 5 * 60_000 });
      await expect(loserStatus, 'a used invoice must stop automatic checking').toHaveCount(0);
      expect(answers.get(loser)!.some((a) => a.status === 400 && SAYS.used.test(a.body))).toBe(true);
      await footage.result(loser, 'Other window refused the used invoice');
      await reopenFeed(loser, footage);
      await expect(loser.getByTestId('feed-compose'), 'the other window does not see premium after reloading').toBeVisible({ timeout: 90_000 });
      await footage.settled(loser, 'Other window now offers the composer');
      expect(await readPendingInvoice(page), 'the redeemed invoice is still remembered').toBeNull();

      // The payment left alice's balance (the payment window's Home).
      await pay.bringToFront();
      await tabRoot(pay, footage, 'home', 'Go to Home');
      await expect.poll(async () => (await readAssetBalance(pay, 'ltc')).amount ?? Number.POSITIVE_INFINITY, {
        timeout: 30 * 60_000,
        intervals: [30_000],
        message: 'alice LTC balance never dropped by the amount paid',
      }).toBeLessThanOrEqual(before.amount! - Number(request.amount) + 1e-8);
      const after = await readAssetBalance(pay, 'ltc');
      footage.evidence('alice_ltc_after', after.amount ?? -1);
      await footage.result(pay, 'Alice Litecoin balance after');

      // Posting is public and permanent: only with the owner's approval.
      await winner.bringToFront();
      const compose = winner.getByTestId('feed-compose');
      await expect(compose).toBeEnabled();
      if (!POST_APPROVED) {
        await expect(winner.getByTestId('feed-post'), 'Post must stay disabled while the composer is empty').toBeDisabled();
        test.info().annotations.push({ type: 'not-run', description: 'Posting needs owner approval (E2E_PREMIUM_POST=1).' });
        await footage.result(winner, 'Composer ready, posting not approved');
      } else {
        footage.mark('Premium post to the feed', 'alice');
        await footage.type(compose, NOTE_TEXT, 'Write a post');
        await footage.tap(winner.getByTestId('feed-post'), 'Post');
        const signing = winner.getByTestId('operation-password');
        if (await signing.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await alice.confirmOperationPassword(winner);
        await expect(winner.getByTestId('feed-note').filter({ hasText: NOTE_TEXT }).first()).toBeVisible({ timeout: 90_000 });
        await footage.result(winner, 'Post published');
        await footage.tap(winner.getByTestId('feed-refresh'), 'Refresh the feed');
        await expect(winner.getByTestId('feed-note').filter({ hasText: NOTE_TEXT }).first(), 'the relay did not serve the post back').toBeVisible({ timeout: 90_000 });
        await footage.result(winner, 'Post served back by the relay');
      }

      await footage.closePage(checkout, 'Close the checkout');
      await footage.closePage(pay, 'Close the payment window');
      await footage.closePage(second, 'Close the second window');
    });
  });
}
