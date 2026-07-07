import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';

/**
 * Auto-unlock (session-cache) RESTORE — the regression that broke sign-in TWICE
 * on 2026-07-07 and had no coverage. With a multi-hour auto-lock set, closing +
 * reopening the popup must RESTORE the wallet from the session cache WITHOUT
 * re-onboarding and WITHOUT the auth bootstrap failing.
 *
 * It exercises the two real bugs this gap let through:
 *   1. chrome.storage.session serializes a Uint8Array into a plain object, so the
 *      restored private key was the wrong type → "private key must be hex string
 *      or Uint8Array" (fixed by keystore serialize/reviveForSessionCache).
 *   2. The offscreen bootstrap ran on restore and crashed constructing
 *      ChromeLocalStorage (offscreen has no chrome.storage) → "Receiving end does
 *      not exist" (fixed by bootBackendSelection graceful degrade + per-job
 *      backend forwarding).
 *
 * Returning-user spec: needs a local backend + SMOKE_ALICE_MNEMONIC (an
 * already-registered wallet), like the other import specs. It does NOT create a
 * wallet, so it's safe against any backend — but the balance marker assumes the
 * local smoke backend.
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('auto-unlock: reopening restores from the session cache (no re-sign-in, no key/offscreen error)', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();

  // 1. Import + unlock alice; Home is up + authenticated.
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  // 2. Set a 4-hour auto-lock. setAutoLock writes the session cache immediately —
  //    the exact keys+addresses payload that must survive chrome.storage's
  //    Uint8Array serialization.
  await page.getByTestId('nav-tab-settings').click();
  await page.getByTestId('settings-autolock-select').selectOption({ value: '240' });
  await page.waitForTimeout(750); // let the async writeSessionCache land

  // 3. Reopen the popup in a fresh page → the restore path runs
  //    (tryRestoreSessionCache → revive keys → offscreen/nostr bootstrap).
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/popup.html`);

  // 4. It MUST restore: Home renders, onboarding is NOT shown, and neither of the
  //    two sign-in failures appears.
  const root = reopened.locator('#root');
  await expect(reopened.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });
  await expect(reopened.getByTestId('onboarding-import-btn')).toHaveCount(0);
  await expect(root).not.toContainText("Couldn't sign in");
  await expect(root).not.toContainText('private key must be hex string or Uint8Array');
  await expect(root).not.toContainText('Receiving end does not exist');
});
