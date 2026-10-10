import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, BACKEND_URL } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import {
  THOR_GATEWAY_HOST,
  recordRequests,
  stubNeroswap,
  stubNonlogs,
  stubSwapCapabilities,
  stubThorchain,
} from '../fixtures/E-swaps-stubs.js';
import { FOREIGN_ADDRESS } from '../fixtures/E-swaps-providers.js';

/**
 * Swap wizard: open the Trocador Swap wizard and drive PairStep →
 * QuoteStep against the REAL extension UI.
 *
 * Flow under test (packages/ui/src/components/SwapTab.tsx):
 *   Swap tab → provider list → activate Trocador → PairStep (pick
 *   from/to + amount → "Get quote") → QuoteStep (quote summary +
 *   receive/refund address inputs + "Confirm swap").
 *
 * Trocador is client-direct (packages/swap/src/trocador.ts): the popup
 * hits `https://api.trocador.app/new_rate` straight from the POPUP page,
 * NOT the local smirk-backend-core, and NOT the offscreen document.
 * Because the request originates from the popup page, `page.route` can
 * intercept it. We return a stubbed quote in Trocador's real response
 * shape to keep this deterministic and free of an external rate service
 * (and its per-pair minimums / inventory). The UI code path exercised
 * is 100% real; only the upstream provider HTTP is stubbed.
 *
 * Auth: we import alice via the shared `importAndUnlock` helper. The
 * helper drives the full onboarding-import flow and returns once the
 * wallet is authenticated, detected by a REAL backend balance
 * rendering on Home (alice's WOW 19.79), NOT by waiting on the
 * bootstrap `/auth/extension` POST. That POST fires from the
 * extension's OFFSCREEN document, whose network is invisible to
 * Playwright's page/context response listeners, so any
 * `waitForResponse('/auth/extension')` always times out. See
 * fixtures/onboard.ts for the full rationale.
 *
 * The scenarios after the first cover THORChain, NonLogs and the Where to
 * trade panel the same way: the real popup against the real backend, with
 * the providers' answers taken from recorded fixtures
 * (fixtures/E-swaps-stubs.ts) and the backend's `swaps` capability set by the
 * test. tests/live/e-swaps.live.spec.ts runs the same scenarios live.
 *
 * Requires the extension built with VITE_SMIRK_BACKEND_URL pointed at
 * the local backend (dist already is). Source the seeds first:
 *
 *   set -a && . <monorepo>/packages/smoke-tests/secrets/smoke-mnemonics.env && set +a
 */

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

// A minimal /new_rate response in Trocador's real wire shape
// (packages/swap/src/trocador.ts: TrocadorRateResponse). `quotes.quotes[0]`
// is what TrocadorSwap.quote() reads for amount_to / provider / eta.
const STUB_RATE = {
  trade_id: 'e2e-stub-trade-0001',
  date: '2026-07-01T00:00:00Z',
  ticker_from: 'xmr',
  ticker_to: 'btc',
  coin_from: 'Monero',
  coin_to: 'Bitcoin',
  network_from: 'Mainnet',
  network_to: 'Mainnet',
  amount_from: '0.1',
  amount_to: '0.00123456',
  provider: 'StubProvider',
  fixed: false,
  payment: false,
  status: 'new',
  quotes: {
    quotes: [
      {
        provider: 'StubProvider',
        amount_to: '0.00123456',
        unadjusted_amount_to: 0.00123456,
        eta: 12,
        kycrating: 'A',
        logpolicy: 'B',
        insurance: 0,
        fixed: 'False',
        waste: '0',
        amount_to_USD: '80.00',
        amount_from_USD: '82.00',
        USD_total_cost_percentage: '2.4',
        provider_logo: '',
      },
    ],
  },
};

test('open Swap wizard → activate Trocador → get a quote (reach QuoteStep)', async ({
  context,
  extensionId,
  footage,
}) => {
  const page = await context.newPage();

  // Intercept the client-direct Trocador quote call and return a
  // deterministic stub, so QuoteStep renders without an external rate
  // service. `/new_rate` fires from the POPUP page (not offscreen), so
  // page.route CAN intercept it. Installed before the "Get quote" click.
  await page.route('**://api.trocador.app/new_rate*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(STUB_RATE),
    });
  });

  // ---- Auth/onboarding: import alice (already-registered) ----
  // Returns once authenticated; auth is proven by alice's real backend
  // balance (WOW 19.79) rendering on Home, never by an offscreen
  // /auth/extension wait.
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  footage.mark('wallet-ready', 'unlocked wallet, before the flow under test');

  // Home is up + bottom nav visible.
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  // ---- Navigate to the Swap tab ----
  await page.getByTestId('nav-tab-swap').click();

  // The Swap surface is gated on VITE_TROCADOR_API_KEY at build time;
  // if unset the tab shows a "disabled in this build" message and the
  // provider row never renders. The dist ships a key, so assert the
  // real provider row appears.
  const providerRow = page.getByTestId('swap-provider-trocador');
  await expect(providerRow).toBeVisible({ timeout: 15_000 });

  // ---- Activate the Trocador wizard (PairStep) ----
  await providerRow.click();

  // Wizard header + step indicator confirm we're on PairStep (1/4).
  await expect(page.getByTestId('swap-wizard-step')).toHaveText('1/4');
  await expect(page.getByTestId('swap-pair-get-quote')).toBeVisible();

  // ---- PairStep: pick a supported pair + amount ----
  // TROCADOR_COIN supports btc/ltc/xmr; all three are sendable +
  // receivable, so both pill rows render. Testids use the UPPERCASE
  // ticker (asset.ticker: 'XMR', 'BTC'). Pick XMR → BTC.
  await page.getByTestId('swap-pair-from-XMR').click();
  await page.getByTestId('swap-pair-to-BTC').click();

  // Tiny amount: at or below any realistic balance so the client-side
  // "insufficient" guard (parsedAmount > balance) never disables the
  // button. When the session balance is null the guard is a no-op
  // anyway. The real min is irrelevant: /new_rate is stubbed.
  await page.getByTestId('swap-pair-amount').fill('0.0001');

  const getQuote = page.getByTestId('swap-pair-get-quote');
  await expect(getQuote).toBeEnabled();
  await getQuote.click();

  // ---- Assert we reached QuoteStep with the real quote rendered ----
  // Step advances to 2/4 only after the quote resolves and the wizard
  // patches step=1 (rendered 1-indexed as 2/4). Pure UI assertion, no
  // offscreen network involved.
  await expect(page.getByTestId('swap-wizard-step')).toHaveText('2/4', {
    timeout: 20_000,
  });

  // Meaningful outcome: the QuoteStep confirm CTA + address inputs are
  // present, and the stubbed receive estimate / provider are rendered
  // from the quote (not just "a button exists").
  await expect(page.getByTestId('swap-quote-confirm')).toBeVisible();
  await expect(page.getByTestId('swap-quote-to-address')).toBeVisible();
  await expect(page.getByTestId('swap-quote-refund-address')).toBeVisible();

  // The stub's amount_to (0.00123456 BTC → 123456 atomic @ 8 dp) is
  // formatted back into the "You receive (est.)" summary row. trimZeros
  // leaves it as 0.00123456 (no trailing zeros to strip).
  await expect(page.locator('#root')).toContainText('0.00123456');
  // The stub provider surfaces on the "Provider" summary row.
  await expect(page.locator('#root')).toContainText('StubProvider');

  // Live quote (not expired) → CTA reads "Confirm swap".
  await expect(page.getByTestId('swap-quote-confirm')).toHaveText(/Confirm swap/i);
  footage.mark('swap-quote-shown', 'live swap quote with provider + rate');

  console.log(
    'QUOTE_STEP>>>',
    (await page.locator('#root').innerText()).replace(/\s+/g, ' ').slice(0, 700),
  );
});


// ---------------------------------------------------------------------------
// THORChain, NonLogs and Where to trade, with recorded provider answers.
// ---------------------------------------------------------------------------

const BACKEND_HOST = new URL(BACKEND_URL).host;
const thirdParty = (seen: { host: string; at: number }[], since = 0) =>
  [...new Set(seen.filter((e) => e.at >= since && e.host !== BACKEND_HOST).map((e) => e.host))].sort();

/** The message line rendered just above a button (step error rows). */
async function lineAbove(page: Page, button: string): Promise<string | null> {
  const lines = (await page.locator('#root').innerText()).split('\n').map((l) => l.trim()).filter(Boolean);
  const at = lines.lastIndexOf(button);
  return at > 0 ? lines[at - 1]! : null;
}

/** Open the THORChain card (a first tap checks it) and its wizard. */
async function openThorchainWizard(page: Page): Promise<string> {
  await page.getByTestId('nav-tab-swap').click();
  const card = page.getByTestId('swap-provider-thorchain');
  await card.click();
  await expect(card).toContainText('Live now', { timeout: 20_000 });
  const text = (await card.innerText()).replace(/\s+/g, ' ');
  await card.click();
  await expect(page.getByTestId('swap-wizard-step')).toHaveText('1/4');
  return text;
}

/** Pick a pair and amount and get to the quote step. */
async function quote(page: Page, from: string, to: string, amount: string): Promise<void> {
  await page.getByTestId(`swap-pair-from-${from}`).click();
  await page.getByTestId(`swap-pair-to-${to}`).click();
  await page.getByTestId('swap-pair-amount').fill(amount);
  const button = page.getByTestId('swap-pair-get-quote');
  await expect(button, `the wallet's ${from} balance covers ${amount}`).toBeEnabled();
  await button.click();
  await expect(page.getByTestId('swap-wizard-step')).toHaveText('2/4', { timeout: 20_000 });
}

const notices = (page: Page) => page.getByTestId('swap-quote-notices').locator('li').allInnerTexts();

test('THORChain quotes show fee lines from the destination coin, no affiliate line, and never XMR', async ({ context, extensionId }) => {
  const page = await context.newPage();
  // XMR is listed by this THORChain stub: only the wallet's policy keeps it out.
  await stubThorchain(page, { xmrPool: true });
  await stubSwapCapabilities(page, { thorchain: { enabled: true }, nonlogs: { enabled: false } });
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });

  const card = await openThorchainWizard(page);
  expect(card).toMatch(/Live now: BTC, LTC\./);
  expect(card).not.toContain('XMR');
  await expect(page.getByTestId('swap-pair-from-XMR')).toHaveCount(0);
  await expect(page.getByTestId('swap-pair-to-XMR')).toHaveCount(0);

  // BTC to LTC: quote_btc_to_ltc in the recorded fixture, fees in LTC.
  await quote(page, 'BTC', 'LTC', '0.00001');
  await expect(page.getByTestId('swap-quote-fee')).toHaveText('≈ 0.03164706 LTC, included in the estimate');
  await expect(page.locator('#root')).toContainText('12.45633282 LTC');
  let lines = await notices(page);
  expect(lines).toContain("THORChain's fees (liquidity 0.02789891 LTC, outbound 0.00374815 LTC) are already taken out of the estimate.");
  expect(lines.some((n) => n.startsWith('Smirk fee')), 'no affiliate: the server names none').toBe(false);
  expect(lines.some((n) => n.includes('sets a price limit 3% below the estimate'))).toBe(true);
  expect(lines.some((n) => n.includes(THOR_GATEWAY_HOST))).toBe(true);

  // LTC to BTC: quote_ltc_to_btc, fees in BTC.
  await page.getByTestId('swap-wizard-back').click();
  await quote(page, 'LTC', 'BTC', '0.0001');
  await expect(page.getByTestId('swap-quote-fee')).toHaveText('≈ 0.00001829 BTC, included in the estimate');
  lines = await notices(page);
  expect(lines).toContain("THORChain's fees (liquidity 0.00000159 BTC, outbound 0.0000167 BTC) are already taken out of the estimate.");
  expect(lines.some((n) => n.startsWith('Smirk fee'))).toBe(false);
});

test('a THORChain affiliate named by the wallet server gets its own fee line', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const { quotes } = await stubThorchain(page);
  await stubSwapCapabilities(page, { thorchain: { enabled: true, affiliate: { name: 't', bps: 50 } }, nonlogs: { enabled: false } });
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  await openThorchainWizard(page);
  await quote(page, 'BTC', 'LTC', '0.00001');
  // The request named the affiliate, and the screen says what it costs.
  const last = quotes.at(-1)!;
  expect(last.get('affiliate')).toBe('t');
  expect(last.get('affiliate_bps')).toBe('50');
  await expect(page.getByTestId('swap-quote-fee')).toHaveText('≈ 0.09394746 LTC, included in the estimate');
  const lines = await notices(page);
  expect(lines).toContain('Smirk fee 0.5% (0.0623004 LTC), also already taken out of the estimate.');
});

test('NonLogs lists only wallet coins, walks the order book, warns on depth, and pays only this wallet', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const nonlogs = await stubNonlogs(page);
  await stubSwapCapabilities(page, { thorchain: { enabled: false }, nonlogs: { enabled: true } });
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  await page.getByTestId('nav-tab-swap').click();

  // The asset list: NonLogs also lists GRIN, which never swaps in-app.
  const card = page.getByTestId('swap-provider-nonlogs');
  await expect(card).toContainText('Live now: BTC, LTC, XMR, WOW.', { timeout: 20_000 });
  await expect(card).not.toContainText('GRIN');
  await card.click();
  await expect(page.getByTestId('swap-pair-from-GRIN')).toHaveCount(0);

  // A quote with the order-book walk (the recorded WOW-XMR book).
  await quote(page, 'XMR', 'WOW', '0.0001');
  const book = page.getByTestId('swap-book-analysis');
  await expect(book).toBeVisible();
  await expect(book).toContainText('Route');
  await expect(book).toContainText('WOW-XMR');
  await expect(book).toContainText('0.15% taker per leg (1), 0.8% convenience fee');
  expect(Number((await page.getByTestId('swap-book-expected').innerText()).match(/([\d.]+)/)?.[1])).toBeGreaterThan(0);
  await expect(book).not.toContainText('larger than the visible order book');
  expect(await notices(page)).toContain('NonLogs minimum for this pair: 0.01.');

  // Foreign payout, then foreign refund: both refused before any swap exists.
  await page.getByTestId('swap-quote-to-address').fill(FOREIGN_ADDRESS.wow);
  await page.getByTestId('swap-quote-confirm').click();
  await expect.poll(() => lineAbove(page, 'Confirm swap')).toMatch(/pay only to this wallet/);
  await page.getByTestId('swap-quote-use-my-to-address').click();
  await page.getByTestId('swap-quote-refund-address').fill(FOREIGN_ADDRESS.xmr);
  await page.getByTestId('swap-quote-confirm').click();
  await expect.poll(() => lineAbove(page, 'Confirm swap')).toMatch(/refunds only to this wallet/);
  await expect(page.getByTestId('swap-wizard-step')).toHaveText('2/4');
  expect(nonlogs.created, 'no NonLogs swap was created').toHaveLength(0);

  // The same amount against a thin book: the depth warning, never executed.
  nonlogs.setBook('thin');
  await page.getByTestId('swap-wizard-back').click();
  await page.getByTestId('swap-pair-get-quote').click();
  await expect(page.getByTestId('swap-wizard-step')).toHaveText('2/4', { timeout: 20_000 });
  await expect(book).toContainText('This order is larger than the visible order book. At most 0.000017 XMR fills at the posted prices');
  expect(nonlogs.created).toHaveLength(0);
});

test('the Swap tab asks no provider until a tap, and Where to trade asks for prices only on its own', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const seen = recordRequests(page);
  await stubThorchain(page);
  await stubNeroswap(page);
  await stubSwapCapabilities(page, { thorchain: { enabled: true }, nonlogs: { enabled: false } });
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });

  const opened = Date.now();
  await page.getByTestId('nav-tab-swap').click();
  const card = page.getByTestId('swap-provider-thorchain');
  await expect(card).toContainText(THOR_GATEWAY_HOST);
  await expect(page.getByTestId('swap-where-to-trade')).toContainText('BasicSwap');
  // The tab's mount effects have run once NonLogs' own mount read (the
  // wallet server's capabilities) has answered. A provider request fired
  // later, before its tap, is caught by the per-host checks below, and any
  // other host by the final host list.
  await expect(page.getByTestId('swap-provider-nonlogs')).toContainText('Not offered by this wallet server.', { timeout: 20_000 });
  expect(thirdParty(seen, opened), 'only the wallet server before any tap').toEqual([]);

  const thorTap = Date.now();
  await card.click();
  await expect(card).toContainText('Live now', { timeout: 20_000 });
  expect(thirdParty(seen, opened)).toEqual([THOR_GATEWAY_HOST]);
  expect(seen.filter((e) => e.host === THOR_GATEWAY_HOST && e.at < thorTap)).toHaveLength(0);

  const pricesTap = Date.now();
  await page.getByTestId('swap-where-to-trade-show-prices').click();
  await expect(page.getByTestId('swap-where-to-trade')).toContainText('WOW-BTC: bid 0.0000012, ask 0.0000013', { timeout: 20_000 });
  expect(thirdParty(seen, opened)).toEqual([THOR_GATEWAY_HOST, 'neroswap.com'].sort());
  expect(seen.filter((e) => e.host === 'neroswap.com' && e.at < pricesTap)).toHaveLength(0);
});

test('a THORChain swap started in the popup is back on its deposit step after the popup reopens', async ({ context, extensionId }) => {
  // Context-wide stubs, so the reopened popup gets them too.
  await stubThorchain(context);
  await stubSwapCapabilities(context, { thorchain: { enabled: true }, nonlogs: { enabled: false } });
  const password = randomBytes(24).toString('base64url');
  let page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC!, password });
  await openThorchainWizard(page);
  await quote(page, 'BTC', 'LTC', '0.00001');
  await page.getByTestId('swap-quote-use-my-to-address').click();
  await page.getByTestId('swap-quote-confirm').click();
  await expect(page.getByTestId('swap-wizard-step')).toHaveText('3/4', { timeout: 20_000 });
  await expect(page.getByTestId('swap-deposit-memo-warning')).toBeVisible();
  const receive = await page.getByTestId('swap-deposit-receive').innerText();

  // Close the popup and open it again.
  await page.close();
  page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const lock = page.getByTestId('lockscreen-root');
  await expect(lock.or(page.getByTestId('bottom-nav'))).toBeVisible({ timeout: 30_000 });
  if (await lock.isVisible()) {
    await page.getByTestId('lockscreen-password-input').fill(password);
    await page.getByTestId('lockscreen-unlock-btn').click();
    await expect(lock).toHaveCount(0, { timeout: 60_000 });
  }
  const step = page.getByTestId('swap-wizard-step');
  if (!(await step.isVisible().catch(() => false))) await page.getByTestId('nav-tab-swap').click();
  await expect(step).toHaveText('3/4', { timeout: 30_000 });
  await expect(page.getByTestId('swap-deposit-memo-warning')).toBeVisible();
  await expect(page.getByTestId('swap-deposit-receive')).toHaveText(receive);
});
