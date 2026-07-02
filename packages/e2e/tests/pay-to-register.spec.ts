import { test, expect } from '../fixtures/extension.js';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/**
 * Pay-to-register gate — a FRESH (unregistered) wallet against a backend whose
 * `/capabilities` reports `payment_required: true`.
 *
 * Expected product behaviour: onboarding must NOT complete. A genuinely new
 * pubkey has no settled invoice, so `/auth/extension` is rejected by the
 * `enforce_payment` gate (HTTP 400 VALIDATION_ERROR, message "Registration on
 * this instance requires payment. Request an invoice from /auth/payment-invoice,
 * pay it, then retry."). That error propagates:
 *
 *   offscreen bootstrap-auth (handlers/bootstrap-auth.ts) throws the payment
 *     message (friendlyRegisterError, 400 branch returns the raw message)
 *       → popup onComplete (popup/index.tsx, calls bootstrapAuthInExtension)
 *         → OnboardingWizard.handleSubmit catch (OnboardingWizard.tsx:176) →
 *           setError(message) → the SetPassword step re-renders with a red
 *           <FieldError> (OnboardingWizard.tsx:665) and the wizard STAYS on the
 *           password step.
 *
 * So the observable, meaningful outcome is: the wizard stays on the password
 * step (`onboarding-set-password-submit` still present), Home never appears
 * (no balance calls fire), and a payment-required message is surfaced. There is
 * no dedicated invoice-screen testid in the client yet (the pay-to-register
 * client UI is still being designed) — this asserts the GATE, which is the real,
 * testable behaviour.
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
  expect(
    registration.payment_required,
    'backend must run with REGISTRATION_REQUIRE_PAYMENT=on for this scenario — otherwise the gate never fires',
  ).toBe(true);

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

  // Set a password → submit. This runs onComplete → bootstrapAuthInExtension,
  // which registers the (new) wallet against /auth/extension in the OFFSCREEN
  // document. Because the wallet is unregistered and the backend requires
  // payment, registration is rejected (400) and the wizard's handleSubmit catch
  // sets the error and drops back to the password step.
  await page.getByTestId('onboarding-password-input').fill(PASSWORD);
  await page.getByTestId('onboarding-password-confirm-input').fill(PASSWORD);
  await page.getByTestId('onboarding-set-password-submit').click();

  // ---- Meaningful UI outcome: the gate surfaced a payment-required error. ----
  // FieldError has no testid (plain red text under the password field), so
  // assert on the wizard's rendered text. This is the signal that the offscreen
  // bootstrap threw the backend's payment message all the way up to the wizard.
  await expect(page.locator('#root')).toContainText(/payment|invoice|pay/i, {
    timeout: 30_000,
  });

  // The wizard is STILL on the SetPassword step — it never advanced to the
  // Smirk-setup step or to Home. (handleSubmit's catch re-renders `password`.)
  await expect(page.getByTestId('onboarding-set-password-submit')).toBeVisible();

  // The post-registration setup-finish step must NOT be reachable.
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
