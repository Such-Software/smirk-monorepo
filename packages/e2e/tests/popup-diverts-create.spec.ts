/**
 * popup-diverts-create: the action popup must never mint a recovery phrase.
 *
 * Reported from real use on 2026-08-23 (Brave, macOS): create a wallet, copy the
 * phrase, switch windows to paste it somewhere safe, come back. The browser had
 * destroyed the popup on blur and rebuilt it at the welcome screen, so pressing
 * create again produced a DIFFERENT phrase. Save the first, fund the second, and
 * the phrase in your hand unlocks a wallet that is not yours, with nothing on
 * screen saying so.
 *
 * The mnemonic is held in memory on purpose so it never reaches
 * chrome.storage.session (2026-05-10 audit), so the fix is the surface: create
 * hands off to a tab, which survives losing focus. Import is deliberately NOT
 * diverted; the phrase already exists there and losing the screen costs only
 * retyping, so that path is covered by the unchanged onboarding-import spec.
 *
 * This asserts the diversion itself: in the popup, create must not reach a
 * phrase. It is the regression guard for the whole class.
 */
import { test, expect } from '../fixtures/extension.js';

test('the action popup diverts create instead of generating a phrase', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  // No ?ctx=tab: this is the plain action popup, the surface that cannot hold a
  // phrase safely.
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  const createBtn = page.getByTestId('onboarding-create-btn');
  await expect(createBtn).toBeVisible({ timeout: 30_000 });
  await createBtn.click();

  // The reveal screen must NOT appear here. Its first word is the tell: if that
  // renders in the popup, a phrase has been minted on a surface that dies on
  // blur, which is exactly the reported bug.
  await expect(page.getByTestId('onboarding-create-seed-word-0')).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('onboarding-create-copy-seed')).toHaveCount(0);

  // Import is untouched: it must still be reachable from the same screen.
  await expect(page.getByTestId('onboarding-import-btn')).toBeVisible();
});

test('the tab surface does generate a phrase', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html?ctx=tab`);

  await page.getByTestId('onboarding-create-btn').click();

  // Same click, durable surface: here the phrase is expected. Without this half,
  // the test above would pass just as well if create were broken everywhere.
  await expect(page.getByTestId('onboarding-create-seed-word-0')).toBeVisible({
    timeout: 30_000,
  });
});
