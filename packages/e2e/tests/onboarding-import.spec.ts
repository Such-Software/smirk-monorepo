import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import { readUserId } from '../fixtures/live-wallets.js';
import { launchExtensionContext } from '../fixtures/A-onboarding-identity-helpers.js';

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
    await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i]!);
  }
  await page.getByTestId('onboarding-import-continue').click();

  // password → submit (runs bootstrap-auth in the offscreen doc → /auth/extension)
  // Both fields mask what is typed.
  await expect(page.getByTestId('onboarding-password-input')).toHaveAttribute('type', 'password');
  await expect(page.getByTestId('onboarding-password-confirm-input')).toHaveAttribute('type', 'password');
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

  // Returning-user bootstrap: no error screen, and the wallet resolved to a
  // backend account (only the id leaves the page, never the token).
  await expect(page.getByTestId('bootstrap-error')).toHaveCount(0);
  await expect.poll(() => readUserId(page), { timeout: 90_000 }).toBeTruthy();
});

/**
 * A returning wallet imported into a second, clean install must land on the
 * SAME account with the SAME Nostr identity. If the backend minted a second
 * identity instead, the handle, tips and premium would stay behind on the old
 * one while everything on screen looked fine.
 */
test('importing the same phrase into a second clean profile resolves to the same account and npub', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(5 * 60_000);
  const readIdentity = async (page: Page) => {
    await expect.poll(() => readUserId(page), { timeout: 90_000 }).toBeTruthy();
    const userId = await readUserId(page);
    await page.getByTestId('nav-tab-settings').click();
    await page.getByTestId('settings-nostr-nav').click();
    const npub = page.getByTestId('nostr-npub');
    await expect(npub).toContainText(/npub1[0-9a-z]{20,}/, { timeout: 20_000 });
    return { userId, npub: ((await npub.textContent()) ?? '').trim() };
  };

  const first = await context.newPage();
  await importAndUnlock(first, { extensionId, mnemonic: MNEMONIC! });
  const original = await readIdentity(first);

  const second = await launchExtensionContext();
  try {
    const page = await second.context.newPage();
    await importAndUnlock(page, { extensionId: second.extensionId, mnemonic: MNEMONIC! });
    const again = await readIdentity(page);
    expect(again.userId, 'the second install resolved to a different account: a new identity was minted').toBe(original.userId);
    expect(again.npub, 'the second install derived a different npub from the same phrase').toBe(original.npub);
  } finally {
    await second.context.close();
  }
});
