import { test, expect } from '../fixtures/extension.js';

/**
 * Phase 0b: import an existing wallet and read REAL balances from the backend.
 *
 * Drives the whole onboarding-import flow against a local smirk-backend-core
 * (extension built with VITE_SMIRK_BACKEND_URL=…/api/v1 + VITE_SMIRK_API_STYLE=
 * namespaced). alice is already registered, so bootstrap-auth (which runs in the
 * offscreen document) authenticates as a returning user and the Home fetches her
 * balances. The balance values are the assertion: they only render non-zero if
 * the offscreen auth token is valid on THIS backend, the regression that guards
 * the offscreen `initSmirkApi` fix (without it, auth hits production and every
 * balance reads 0).
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();
const PASSWORD = 'e2e-test-password-123';

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('import wallet → authenticate → real balances from the backend', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // welcome → import → warning → continue
  await page.getByTestId('onboarding-import-btn').click();
  await page.getByTestId('onboarding-import-warning-continue').click();

  // seed words
  const words = MNEMONIC!.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i]);
  }
  await page.getByTestId('onboarding-import-continue').click();

  // password → submit (runs bootstrap-auth in the offscreen doc → /auth/extension)
  await page.getByTestId('onboarding-password-input').fill(PASSWORD);
  await page.getByTestId('onboarding-password-confirm-input').fill(PASSWORD);
  await page.getByTestId('onboarding-set-password-submit').click();

  // optional Smirk-setup step → finish, if present
  await page
    .getByTestId('onboarding-setup-finish-btn')
    .click({ timeout: 25_000 })
    .catch(() => {
      /* hasSetupStep === false → skipped straight to Home */
    });

  // Home is up and the REAL backend balances render.
  //
  // The CryptoNote balances are the signal, and specifically that they are
  // NON-ZERO. BTC and LTC render from a source that does not need our auth, so
  // an unauthenticated wallet still shows a plausible-looking Home; what it
  // cannot do is fill in XMR and WOW, which come from the LWS behind the
  // offscreen token. The observed pre-auth state is exactly "XMR 0, WOW 0"
  // while BTC and LTC are already populated, so this reads the one column that
  // actually distinguishes authenticated from not.
  //
  // Deliberately NOT a literal amount. This asserted "19.79" until the
  // live-money gate spent from this very wallet and left it at 19.78, breaking
  // a passing test by succeeding at its job. Any top-up or locked output would
  // have done the same. See the same reasoning in fixtures/onboard.ts.
  await expect(page.getByTestId('onboarding-import-btn')).toHaveCount(0);
  const root = page.locator('#root');
  const nonZero = /(Monero\s*XMR|Wownero\s*WOW)\s*0*\.?0*[1-9]/;
  await expect
    .poll(async () => nonZero.test(await root.innerText()), {
      timeout: 40_000,
      message:
        'XMR and WOW stayed at 0 while BTC/LTC populated, which is what Home ' +
        'looks like when the offscreen auth token is missing or invalid',
    })
    .toBe(true);
  // Both of them, not just whichever arrived first.
  await expect(root).toContainText(/Monero\s*XMR\s*0*\.?0*[1-9]/);
  await expect(root).toContainText(/Wownero\s*WOW\s*0*\.?0*[1-9]/);
});
