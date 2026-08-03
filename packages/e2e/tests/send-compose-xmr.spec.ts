import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';

/**
 * send-compose-xmr: drive the REAL Send wizard for Monero (XMR) from
 * Home through Asset → Address → Compose and land on the read-only
 * Review step. We deliberately STOP at Review and never click
 * `send-review-submit`, so nothing is broadcast.
 *
 * Auth/onboarding: import the ALREADY-REGISTERED wallet alice via the
 * shared `importAndUnlock` helper. It drives the full onboarding-import
 * flow and returns once the wallet is authenticated, detected by a REAL
 * backend balance rendering on Home (alice's WOW 19.79), NOT by waiting
 * on the bootstrap `/auth/extension` POST.
 *
 * WHY NOT wait on /auth/extension: that POST fires from the extension's
 * OFFSCREEN document, whose network is invisible to Playwright's
 * page/context response listeners, so any `waitForResponse('/auth/
 * extension')` ALWAYS times out. The prior version of this spec did
 * exactly that and timed out at 30s every run. For the balance signal we
 * instead lean on `/wallet/lws/balance`, which fires from the POPUP page
 * (via refreshBalances → fetchAllBalances) and IS capturable, never
 * offscreen.
 *
 * Preconditions:
 *   - extension built with VITE_SMIRK_BACKEND_URL=http://127.0.0.1:8080/api/v1
 *     and VITE_SMIRK_API_STYLE=namespaced (dist already is: do NOT rebuild).
 *   - seed env sourced:
 *       set -a && . <monorepo>/packages/smoke-tests/secrets/smoke-mnemonics.env && set +a
 *
 * UI map (verified against packages/ui/src/components/SendWizard.tsx):
 *   Home action bar → `home-action-send`             (UnifiedBalance.tsx)
 *   Wizard step 0 (asset)   → `send-asset-xmr`        (PickAsset)
 *   Wizard step 1 (address) → `send-address-input` + `send-address-continue`
 *   Wizard step 2 (compose) → `send-amount-input` + `send-compose-continue`
 *   Wizard step 3 (review)  → `send-review-submit`    (asserted, NOT clicked)
 *
 * XMR has no fee-tier picker (family 'cryptonote'); Compose gates
 * "Continue to review" on a positive amount that does not exceed the
 * confirmed balance, so we size the amount as a small fraction of the
 * balance the wizard displays (alice holds ~0.19 XMR on the test backend).
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

// A real, checksum-valid mainnet Monero standard address (getmonero.org
// donation address). It only needs to pass the client-side
// `isValidXmrAddress` decode+checksum on the Address step; nothing is
// ever sent to it.
const XMR_RECIPIENT =
  '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('Send → XMR → address + amount → reach Review (no broadcast)', async ({
  context,
  extensionId,
  footage,
}) => {
  // Surface popup-page backend traffic for debugging (the LWS balance
  // hit is the load-bearing, CAPTURABLE signal for XMR here).
  context.on('response', (r) => {
    const u = r.url();
    if (u.includes('127.0.0.1:8080')) {
      console.log('BACKEND', r.status(), u.split('8080')[1] ?? u);
    }
  });

  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/auth|bootstrap|token|register|error|fail|401|pow/i.test(t)) {
      console.log('CONSOLE', m.type(), t.slice(0, 180));
    }
  });

  // --- Onboarding: import alice (returning user → no PoW, no gate) -------
  // Returns once authenticated; auth is proven by alice's real backend
  // balance (WOW 19.79) rendering on Home, never by an offscreen
  // /auth/extension wait. Do NOT wait on that POST; it fires offscreen and
  // is invisible to Playwright (the bug the old version tripped on).
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  footage.mark('wallet-ready', 'unlocked wallet, before the flow under test');

  // Onboarding gone; Home is up + authenticated.
  await expect(page.getByTestId('onboarding-import-btn')).toHaveCount(0);
  await expect(page.getByTestId('home-action-send')).toBeVisible({ timeout: 40_000 });

  // Wait for a real (authenticated, non-401) XMR/LWS balance so the
  // Compose step has a non-zero balance to validate against. This
  // /wallet/lws/balance hit originates from the POPUP page (refreshBalances
  // → fetchAllBalances), so (unlike the offscreen bootstrap-auth POST) it
  // IS visible to page.waitForResponse. If it's already warm/cached we
  // tolerate the timeout and fall back to reading the balance the Compose
  // screen renders below.
  await page
    .waitForResponse(
      (r) => r.url().includes('/wallet/lws/balance') && r.status() === 200,
      { timeout: 40_000 },
    )
    .catch(() => {
      /* balance may already be cached/warm: tolerate and rely on the
         balance-derived amount logic below. */
    });

  // --- Send wizard: Home → XMR → Address → Compose → Review -------------
  await page.getByTestId('home-action-send').click();

  // Step 0: pick XMR.
  const xmrPick = page.getByTestId('send-asset-xmr');
  await expect(xmrPick).toBeVisible({ timeout: 15_000 });
  await xmrPick.click();

  // Step 1: recipient address.
  const addr = page.getByTestId('send-address-input');
  await expect(addr).toBeVisible();
  await addr.fill(XMR_RECIPIENT);
  const addrContinue = page.getByTestId('send-address-continue');
  await expect(addrContinue).toBeEnabled();
  await addrContinue.click();

  // Step 2: compose amount. Read the balance the wizard shows and pick a
  // small fraction of it so the amount is positive but below balance
  // (XMR has no fee picker; Continue is gated on amount ≤ balance).
  const amountInput = page.getByTestId('send-amount-input');
  await expect(amountInput).toBeVisible({ timeout: 15_000 });

  // The Compose balance line renders "Balance: <n> XMR". Parse it and
  // send half; fall back to a tiny fixed amount if it can't be read.
  await expect(page.locator('#root')).toContainText(/Balance:\s*[\d.]+\s*XMR/i, {
    timeout: 15_000,
  });
  const composeText = (await page.locator('#root').innerText()).replace(/\s+/g, ' ');
  const balMatch = /Balance:\s*([\d.]+)\s*XMR/i.exec(composeText);
  const balance = balMatch ? parseFloat(balMatch[1]!) : NaN;
  const amountXmr =
    Number.isFinite(balance) && balance > 0 ? (balance / 2).toFixed(6) : '0.0001';
  console.log('COMPOSE balance=', balMatch?.[1] ?? '(unparsed)', 'amount=', amountXmr);

  await amountInput.fill(amountXmr);

  const composeContinue = page.getByTestId('send-compose-continue');
  // For XMR the button reads "Continue to review". It stays disabled until
  // the amount validates against balance; assert it enabled so a stale/
  // zero balance produces a clear failure here rather than a silent stall.
  await expect(composeContinue).toContainText(/Continue to review/i);
  await expect(composeContinue).toBeEnabled({ timeout: 15_000 });
  await composeContinue.click();

  // --- Step 3: Review reached (read-only). Assert, do NOT submit. -------
  // The presence of the Send button is the definitive "we're on Review"
  // signal; the ReviewRows echo back what we entered. All assertions here
  // are pure UI (no offscreen network); the meaningful outcome is the
  // review screen rendering fee/amount/confirm affordances.
  const reviewSubmit = page.getByTestId('send-review-submit');
  await expect(reviewSubmit).toBeVisible({ timeout: 15_000 });

  const root = page.locator('#root');
  // Review header + asset row.
  await expect(root).toContainText('Review');
  await expect(root).toContainText(/Monero \(XMR\)/i);
  // Amount + Network-fee rows are the fee/amount affordance the Review
  // screen renders for a cryptonote send (fee is "computed at send" /
  // "~<est>"; the Amount row echoes what we entered).
  await expect(root).toContainText(/Amount/i);
  await expect(root).toContainText(/Network fee/i);
  // Recipient address echoed in full on Review (mono row, not truncated).
  await expect(root).toContainText(XMR_RECIPIENT);
  // Submit button label confirms the read-only commit affordance exists
  // (either "Send 🔓" for a normal send or "Send Max 🔓" for sweep).
  await expect(reviewSubmit).toContainText(/Send/i);
  footage.mark('send-review-reached', 'XMR send composed, Review step with fee + recipient');

  // Guard: we must NOT have advanced past Review (no Done screen / txid).
  await expect(page.getByTestId('send-done-txid')).toHaveCount(0);

  console.log(
    'REVIEW_TEXT>>>',
    (await root.innerText()).replace(/\s+/g, ' ').slice(0, 600),
  );
});
