import { test, expect } from '../fixtures/extension.js';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/**
 * Pay-to-register gate — a FRESH (unregistered) wallet against a backend whose
 * `/capabilities` reports `payment_required: true`.
 *
 * Expected product behaviour: onboarding must NOT complete. The wizard reads the
 * backend's registration policy from `/capabilities` (planRegistration) and,
 * seeing `payment_required`, ROUTES to the pay-to-register step after the
 * password. That step mints an invoice bound to the wallet's BTC key and polls
 * `/auth/extension` for settlement; a genuinely new pubkey never pays here, so
 * the backend keeps rejecting (`enforce_payment`, HTTP 400 "Payment not yet
 * confirmed") and the poll stays pending forever.
 *
 * So the observable, meaningful outcome is: the wizard ADVANCES to the payment
 * step (`onboarding-payment-step` visible, off the password step), and Home
 * never appears (no balance calls fire) because registration never settles.
 * (Whether the invoice-mint call itself succeeds depends on the test backend's
 * payment-provider wiring; the router + non-completion are the real, testable
 * behaviour either way.)
 *
 * CRITICAL — do NOT `waitForResponse('/auth/extension')`. The bootstrap-auth
 * POST fires from the extension's OFFSCREEN document, whose network is invisible
 * to Playwright's page/context response listeners, so any such wait ALWAYS times
 * out. We therefore assert only on capturable signals:
 *   - `/capabilities` read via `page.request.get` (a Playwright-context request,
 *     not a page-origin fetch — no CORS, always capturable);
 *   - the popup UI (getByTestId / #root text) reflecting the blocked state;
 *   - the ABSENCE of a `/wallet/.../balance` response (those DO originate from
 *     the popup page and so are capturable — a blocked wallet never fires them).
 *
 * Why a fresh random mnemonic (NOT alice/bob/carol / importAndUnlock): the
 * funded smoke wallets are already registered, so `checkRestore` returns
 * exists:true and the backend's returning-user bypass SKIPS every registration
 * gate — including payment. Only a never-seen pubkey trips the gate. We generate
 * a valid 12-word BIP-39 phrase with the same @scure/bip39 + english wordlist
 * the wizard's isValidMnemonic uses (packages/core/src/hd.ts), so the import
 * step validates it.
 *
 * PRECONDITIONS (must be true when this runs, else it is meaningless):
 *   1. The backend at 127.0.0.1:8080 is started with REGISTRATION_REQUIRE_PAYMENT=on
 *      (PAYMENT_* provider vars wired) so /capabilities reports payment_required.
 *   2. The extension dist is built against the local backend
 *      (VITE_SMIRK_BACKEND_URL=http://127.0.0.1:8080/api/v1,
 *      VITE_SMIRK_API_STYLE=namespaced) — already the case for this dist.
 *
 * Requires the seed env only to gate the run (we still generate our own fresh
 * seed); we reuse SMOKE_ALICE_MNEMONIC as the "smoke suite is wired" signal so
 * this skips cleanly in environments that never provisioned the backend.
 */
const PASSWORD = 'e2e-test-password-123';
const CAPABILITIES_URL = 'http://127.0.0.1:8080/api/v1/capabilities';

test.skip(
  !process.env.SMOKE_ALICE_MNEMONIC,
  'SMOKE_ALICE_MNEMONIC not set — smoke backend/secrets not provisioned; source secrets/smoke-mnemonics.env',
);

test('fresh wallet → payment_required backend blocks onboarding (pay-to-register gate)', async ({
  context,
  extensionId,
}) => {
  // A fresh, never-registered 12-word phrase. Valid per @scure/bip39 (128 bits),
  // which is exactly what the wizard's isValidMnemonic checks against.
  const freshMnemonic = generateMnemonic(wordlist, 128);
  const words = freshMnemonic.split(/\s+/);
  expect(words).toHaveLength(12);

  // ---- Precondition: the instance actually advertises the payment gate. ----
  // Read /capabilities via the Playwright request context (NOT a page-origin
  // fetch): no CORS, and it's a capturable request unlike the offscreen
  // bootstrap. If this backend isn't gated the whole scenario is meaningless,
  // so surface that loudly rather than pass vacuously.
  const capsRes = await context.request.get(CAPABILITIES_URL);
  expect(capsRes.status(), 'GET /capabilities should be reachable on the test backend').toBe(200);
  const capsBody = (await capsRes.json()) as Record<string, unknown>;
  console.log('CAPABILITIES', JSON.stringify(capsBody).slice(0, 500));
  const registration = (capsBody.registration ?? capsBody) as Record<string, unknown>;
  // Self-adapt to the running instance's operator config: if this backend is NOT
  // payment-gated the gate can never fire, so the scenario is N/A — SKIP rather
  // than fail. (Its mirror image, create-new-wallet.spec.ts, skips when the gate
  // IS on.) One suite run then works against either config.
  test.skip(
    registration.payment_required !== true,
    'backend not running the payment gate (registration.payment_required=false) — pay-to-register N/A on this config',
  );

  // Open the popup.
  const page = await context.newPage();

  // Capturable diagnostic: log any backend response that ORIGINATES FROM THE
  // POPUP PAGE (offscreen traffic never appears here — that's expected).
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('127.0.0.1:8080')) {
      console.log('BACKEND(page)', r.status(), u.split('/api/v1')[1] ?? u);
    }
  });

  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // ---- Drive the import flow with the FRESH phrase. ----
  // welcome → import → warning → continue
  await page.getByTestId('onboarding-import-btn').click();
  await page.getByTestId('onboarding-import-warning-continue').click();

  for (let i = 0; i < words.length; i++) {
    await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i]);
  }
  await page.getByTestId('onboarding-import-continue').click();

  // Set a password → submit. The wizard reads the backend's registration policy
  // (planRegistration over /capabilities) and, because payment_required is on,
  // ROUTES to the pay-to-register step instead of registering immediately. The
  // step mints an invoice (bound to the wallet's BTC key) and polls for
  // settlement; a fresh wallet never pays here, so onboarding cannot complete.
  await page.getByTestId('onboarding-password-input').fill(PASSWORD);
  await page.getByTestId('onboarding-password-confirm-input').fill(PASSWORD);
  await page.getByTestId('onboarding-set-password-submit').click();

  // ---- Meaningful UI outcome: the router advanced to the payment step. ----
  // (Whether the invoice mint succeeds depends on the test backend's payment
  // provider wiring; either way the step renders and onboarding does NOT finish.)
  await expect(page.getByTestId('onboarding-payment-step')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('#root')).toContainText(/payment|invoice|pay/i);

  // It advanced OFF the password step (the router did its job) and never reached
  // the post-registration setup-finish step.
  await expect(page.getByTestId('onboarding-set-password-submit')).toHaveCount(0);
  await expect(page.getByTestId('onboarding-setup-finish-btn')).toHaveCount(0);

  // ---- Home never rendered / no authenticated balance fetch fired. ----
  // Balance requests DO originate from the popup page (fetchAllBalances runs in
  // the popup), so they ARE capturable — a blocked, unauthenticated wallet must
  // never fire one. Poll a short window: seeing one means onboarding wrongly
  // completed.
  const homeReached = await page
    .waitForResponse(
      (r) =>
        r.url().includes('/wallet/lws/balance') || r.url().includes('/wallet/utxo/balance'),
      { timeout: 4_000 },
    )
    .then(() => true)
    .catch(() => false);
  expect(homeReached, 'blocked onboarding must not reach Home / fetch balances').toBe(false);

  console.log(
    'WIZARD_TEXT>>>',
    (await page.locator('#root').innerText()).replace(/\s+/g, ' ').slice(0, 600),
  );
});
