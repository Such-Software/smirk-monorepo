import { randomBytes } from 'node:crypto';
import { test, expect, isSharedBackend, CAPTURE_VIDEO, MARKETING_SHOTS } from '../fixtures/extension.js';
import { getCapabilities } from '../fixtures/capabilities.js';

// Real extension and backend. No chain fixture, existing wallet, or funded account.
// The context closes before a failure is reported so reporters cannot capture a
// recovery phrase or password. Secrets exist only in this process and browser.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('fresh wallet, coin Send shortcut, independent password settings and grace restore', async ({ context, extensionId }) => {
  if (isSharedBackend() || CAPTURE_VIDEO || MARKETING_SHOTS) throw new Error('This fundless check requires a disposable local backend and capture disabled.');
  const caps = await getCapabilities();
  if (caps.registration.payment_required || caps.registration.invite_required) throw new Error('The disposable backend must allow unfunded registration.');
  let stage = 'open onboarding';
  let password = randomBytes(32).toString('base64url');
  const words: string[] = [];
  try {
    let page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html?ctx=tab`);
    await page.getByTestId('onboarding-create-btn').click();
    stage = 'generate recovery phrase';
    await expect(page.getByTestId('onboarding-create-seed-word-0')).toBeVisible();
    for (let i = 0; i < 12; i++) words.push((await page.getByTestId(`onboarding-create-seed-word-${i}`).innerText()).trim().toLowerCase());
    if (words.some(word => !word)) throw new Error('A generated phrase word is missing');
    await page.locator('input[type="checkbox"]').first().check();
    await page.getByTestId('onboarding-create-backed-up-continue').click();
    stage = 'verify generated recovery phrase';
    await expect(page.getByTestId('onboarding-create-continue')).toBeVisible();
    for (let i = 0; i < words.length; i++) {
      const input = page.getByTestId(`onboarding-verify-word-${i}`);
      if (await input.count()) await input.fill(words[i]!);
    }
    await page.getByTestId('onboarding-create-continue').click();
    words.fill('');
    stage = 'encrypt wallet and register against the real backend';
    await page.getByTestId('onboarding-password-input').fill(password);
    await page.getByTestId('onboarding-password-confirm-input').fill(password);
    await page.getByTestId('onboarding-set-password-submit').click();
    await page.getByTestId('onboarding-setup-finish-btn').click({ timeout: 30_000 });
    await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId('onboarding-create-btn')).toHaveCount(0);

    stage = 'coin detail Send goes directly to destination';
    await page.getByTestId('asset-row-ltc').click();
    await page.getByRole('button', { name: /Send/ }).click();
    await expect(page.getByTestId('send-address-input')).toBeVisible();
    await expect(page.getByTestId('send-asset-ltc')).toHaveCount(0);
    await page.getByTestId('nav-tab-settings').click();
    stage = 'set a one-hour grace period';
    await page.getByTestId('settings-autolock-select').selectOption('60');
    const expiry = async () => page.evaluate(async () => {
      const data = await chrome.storage.session.get('smirk_unlocked_session_cache');
      return data.smirk_unlocked_session_cache?.expiresAtMs as number | undefined;
    });
    await expect.poll(expiry).toBeGreaterThan(Date.now());
    const originalExpiry = await expiry();

    stage = 'password settings default off and cancellation preserves them';
    const sends = page.getByTestId('require-password-sends');
    const signing = page.getByTestId('require-password-signing');
    await expect(sends).not.toBeChecked();
    await expect(signing).not.toBeChecked();
    await sends.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(sends).not.toBeChecked();

    stage = 'wrong password cannot enable confirmation';
    await sends.click();
    await page.getByTestId('operation-password').fill(randomBytes(32).toString('base64url'));
    await page.getByTestId('operation-password-confirm').click();
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    await expect(sends).not.toBeChecked();

    stage = 'correct password enables only send confirmation without extending expiry';
    await page.getByTestId('operation-password').fill(password);
    await page.getByTestId('operation-password-confirm').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(sends).toBeChecked();
    await expect(signing).not.toBeChecked();
    expect(await expiry()).toBe(originalExpiry);

    stage = 'restore the complete wallet after closing and reopening';
    await page.close();
    page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId('lockscreen-password-input')).toHaveCount(0);
    expect(await expiry()).toBe(originalExpiry);
    await page.getByTestId('nav-tab-settings').click();
    await expect(page.getByTestId('require-password-sends')).toBeChecked();
    await expect(page.getByTestId('require-password-signing')).not.toBeChecked();

    stage = 'restored session verifies passwords without a second lock and unlock';
    await page.getByTestId('require-password-signing').click();
    await page.getByTestId('operation-password').fill(password);
    await page.getByTestId('operation-password-confirm').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('require-password-signing')).toBeChecked();
    expect(await expiry()).toBe(originalExpiry);

    stage = 'explicit lock revokes another open wallet window';
    const other = await context.newPage();
    await other.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(other.getByTestId('bottom-nav')).toBeVisible();
    await page.getByTestId('settings-lock-now-btn').click();
    await expect(page.getByTestId('lockscreen-password-input')).toBeVisible();
    await expect(other.getByTestId('lockscreen-password-input')).toBeVisible();
    expect(await expiry()).toBeUndefined();
  } catch {
    // Do not preserve Playwright call logs or page snapshots from key screens.
    throw new Error(`Fundless browser check failed during: ${stage}`);
  } finally {
    password = '';
    words.fill('');
    await context.close();
  }
});
