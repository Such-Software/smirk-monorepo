import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';

/**
 * Swap wizard — open the Trocador Swap wizard and drive PairStep →
 * QuoteStep against the REAL extension UI.
 *
 * Flow under test (packages/ui/src/components/SwapTab.tsx):
 *   Swap tab → provider list → activate Trocador → PairStep (pick
 *   from/to + amount → "Get quote") → QuoteStep (quote summary +
 *   receive/refund address inputs + "Confirm swap").
 *
 * Trocador is client-direct (packages/swap/src/trocador.ts): the popup
 * hits `https://api.trocador.app/new_rate` straight from the POPUP page
 * — NOT the local smirk-backend-core, and NOT the offscreen document.
 * Because the request originates from the popup page, `page.route` can
 * intercept it. We return a stubbed quote in Trocador's real response
 * shape to keep this deterministic and free of an external rate service
 * (and its per-pair minimums / inventory). The UI code path exercised
 * is 100% real — only the upstream provider HTTP is stubbed.
 *
 * Auth: we import alice via the shared `importAndUnlock` helper. The
 * helper drives the full onboarding-import flow and returns once the
 * wallet is authenticated — detected by a REAL backend balance
 * rendering on Home (alice's WOW 19.79), NOT by waiting on the
 * bootstrap `/auth/extension` POST. That POST fires from the
 * extension's OFFSCREEN document, whose network is invisible to
 * Playwright's page/context response listeners, so any
 * `waitForResponse('/auth/extension')` always times out. See
 * fixtures/onboard.ts for the full rationale.
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
  page.on('console', (m) => {
    const t = m.text();
    if (/swap|trocador|quote|error|fail|401/i.test(t)) {
      console.log('CONSOLE', m.type(), t.slice(0, 200));
    }
  });

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
  // balance (WOW 19.79) rendering on Home — never by an offscreen
  // /auth/extension wait.
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  footage.mark('wallet-ready', 'unlocked wallet, before the flow under test');

  // Home is up + bottom nav visible.
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  // ---- Navigate to the Swap tab ----
  await page.getByTestId('nav-tab-swap').click();

  // The Swap surface is gated on VITE_TROCADOR_API_KEY at build time —
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
  // anyway. The real min is irrelevant — /new_rate is stubbed.
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
