import { test, expect } from '../fixtures/extension.js';

/**
 * Phase 0, the foundation smoke: prove Playwright can actually load and drive
 * the real MV3 extension. A fresh profile has no wallet, so the popup must land
 * on the onboarding flow. Everything else (import → unlock → balances → sends)
 * builds on this loading + selector-reachability working at all.
 */
test('extension loads and the popup renders onboarding on a fresh profile', async ({
  context,
  extensionId,
}) => {
  expect(extensionId, 'extension id resolved from the background service worker').toMatch(
    /^[a-p]{32}$/,
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // walletState.kind === 'empty' → OnboardingWizard. Assert React mounted into
  // #root and it shows an onboarding affordance (create/import a wallet), not a
  // blank frame or a crash.
  const root = page.locator('#root');
  await expect(root).toBeVisible();
  await expect(root).toContainText(/create|import|recovery|seed|get started|welcome/i);
});
