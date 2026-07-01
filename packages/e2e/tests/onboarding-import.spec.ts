import { test, expect } from '../fixtures/extension.js';

/**
 * Phase 0b — import an existing wallet and read REAL balances from the backend.
 *
 * Drives the whole onboarding-import flow against a local smirk-backend-core
 * (extension built with VITE_SMIRK_BACKEND_URL=…/api/v1 + VITE_SMIRK_API_STYLE=
 * namespaced). alice is already registered, so bootstrap-auth (which runs in the
 * offscreen document) authenticates as a returning user and the Home fetches her
 * balances. The balance values are the assertion: they only render non-zero if
 * the offscreen auth token is valid on THIS backend — the regression that guards
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

  // Home is up and the REAL backend balances render. WOW 19.79 + XMR 0.19 only
  // appear if the offscreen auth token is valid on this backend (0 otherwise).
  await expect(page.getByTestId('onboarding-import-btn')).toHaveCount(0);
  const root = page.locator('#root');
  await expect(root).toContainText('19.79', { timeout: 40_000 }); // WOW
  await expect(root).toContainText('0.19'); // XMR
});
