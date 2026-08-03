import { expect, type Page } from '@playwright/test';

/**
 * Drive the onboarding-IMPORT flow for an ALREADY-REGISTERED wallet and return
 * once the wallet is authenticated against the backend.
 *
 * IMPORTANT: do NOT `waitForResponse('/auth/extension')` to detect auth. The
 * bootstrap-auth pipeline (checkRestore + register) runs in the extension's
 * OFFSCREEN document, whose network is invisible to Playwright's page/context
 * response listeners, so that wait always times out. Instead we use a real
 * backend balance rendering on Home as the auth signal: a non-zero balance only
 * appears if the offscreen auth token is valid on THIS backend (it reads 0 when
 * the offscreen `initSmirkApi` is missing, the bug this suite caught).
 *
 * Defaults assume alice (SMOKE_ALICE_MNEMONIC): WOW 19.79.
 */
export async function importAndUnlock(
  page: Page,
  opts: {
    extensionId: string;
    mnemonic: string;
    password?: string;
    /** Text that only renders once a real backend balance loads (auth OK). */
    balanceMarker?: string | RegExp;
  },
): Promise<void> {
  const password = opts.password ?? 'e2e-test-password-123';
  const words = opts.mnemonic.trim().split(/\s+/);

  await page.goto(`chrome-extension://${opts.extensionId}/popup.html`);
  await page.getByTestId('onboarding-import-btn').click();
  await page.getByTestId('onboarding-import-warning-continue').click();
  for (let i = 0; i < words.length; i++) {
    await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i]);
  }
  await page.getByTestId('onboarding-import-continue').click();
  await page.getByTestId('onboarding-password-input').fill(password);
  await page.getByTestId('onboarding-password-confirm-input').fill(password);
  await page.getByTestId('onboarding-set-password-submit').click();
  // optional Smirk-setup step → finish (absent when the wallet has no setup step)
  await page
    .getByTestId('onboarding-setup-finish-btn')
    .click({ timeout: 25_000 })
    .catch(() => {});

  // Home is up + authenticated (a real backend balance rendered).
  await expect(page.getByTestId('onboarding-import-btn')).toHaveCount(0);
  await expect(page.locator('#root')).toContainText(opts.balanceMarker ?? '19.79', {
    timeout: 40_000,
  });
}
