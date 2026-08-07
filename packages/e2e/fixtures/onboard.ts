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
 * The default readiness signal is STRUCTURAL, not a magic balance. It used to be
 * the literal '19.79' (alice's WOW at the time). That is brittle in the exact
 * situation the suite is meant to support: the live-money gate spends from that
 * wallet, so the moment it ran, every spec sharing this fixture failed on a
 * string that no longer described reality. Balances also move when someone tops
 * the wallet up, or when an output is locked and Home shows "0 🔒 19.78 locked".
 *
 * What actually proves auth is that the backend answered with a real balance
 * set at all, so wait for the fiat total to leave its placeholder. That is
 * exactly as strong (it reads "—" when the offscreen token is missing, which is
 * the bug this suite caught) and it does not encode today's holdings.
 *
 * Pass `balanceMarker` to assert a specific amount where a spec genuinely needs
 * one.
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
  if (opts.balanceMarker !== undefined) {
    await expect(page.locator('#root')).toContainText(opts.balanceMarker, {
      timeout: 60_000,
    });
    return;
  }
  // Structural signal: the fiat headline resolves to an actual figure. "—" is
  // not-available and "…" is loading; either means auth has not landed.
  const total = page.getByTestId('home-total-balance');
  await expect(total).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => (await total.textContent())?.trim() ?? '', {
      timeout: 60_000,
      message:
        'the fiat total never resolved, so the wallet never got a real balance ' +
        'set from the backend: the offscreen auth token is missing or invalid',
    })
    .toMatch(/\d/);
}
