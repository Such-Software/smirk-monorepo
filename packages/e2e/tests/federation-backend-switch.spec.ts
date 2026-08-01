/**
 * Federation: point the wallet at somebody else's backend.
 *
 * "Run your own backend" is one of the three headline features, and the
 * migration done-screen actively invites users to do it. Until now it had ZERO
 * end-to-end coverage, so we were telling people to take a path nobody had
 * walked. Worse, it was actually BROKEN on desktop until the CSP host allowlist
 * was removed, because a self-hosted origin was blocked by the webview before
 * the request left.
 *
 * Requires a SECOND backend instance, which is the point: a mock would prove
 * nothing about federation. `FED_BACKEND_URL` should be an independent instance
 * with its own database and its own peppers, so "the wallet works against it"
 * cannot be satisfied by shared state. Bring one up per docs/private/E2E_ENV.md.
 *
 * What this guards:
 *   - the probe accepts an arbitrary operator's URL and reports its capabilities
 *   - switching is durable, so the wallet keeps talking to the chosen instance
 *   - the wallet does not silently fall back to the built-in default, which
 *     would be the worst outcome: the user believes they are self-hosted while
 *     their traffic goes to api.smirk.cash
 */

import { test, expect } from '../fixtures/extension.js';

const FED_URL = process.env.FED_BACKEND_URL ?? '';
test.skip(
  !FED_URL,
  'FED_BACKEND_URL not set — needs a second independent backend (see docs/private/E2E_ENV.md)',
);

test('the wallet can be pointed at an independent operator backend', async ({
  context,
  extensionId,
  footage,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // The backend picker is reachable before any wallet exists, which matters:
  // choosing an operator BEFORE creating a wallet is the recommended order, so
  // the keystore is registered against the instance the user actually wants.
  await page.evaluate(() => {
    (globalThis as { location: Location }).location.hash = '#/settings/backend';
  });

  const picker = page.getByTestId('backend-picker');
  if (!(await picker.isVisible({ timeout: 5_000 }).catch(() => false))) {
    // Not reachable pre-wallet in this build: drive it from Settings instead.
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const settingsNav = page.getByTestId('nav-tab-settings');
    if (await settingsNav.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await settingsNav.click();
      await page.getByTestId('settings-backend-nav').click();
    }
  }

  await expect(
    page.getByTestId('backend-picker'),
    'backend picker never rendered, so a user cannot choose an operator at all',
  ).toBeVisible({ timeout: 20_000 });
  footage.mark('backend-picker-open', 'operator chooser reachable');

  // Probe the independent instance.
  const input = page.getByTestId('backend-url-input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(FED_URL);
  await page.getByTestId('backend-connect-btn').click();

  // A probe failure here is the federation-is-broken signal: it means the wallet
  // could not read /capabilities from an operator that is demonstrably up.
  const err = page.getByTestId('backend-error');
  if (await err.isVisible({ timeout: 15_000 }).catch(() => false)) {
    throw new Error(
      `probe of the federated backend failed: ${(await err.textContent())?.trim()}\n` +
        `The instance at ${FED_URL} is reachable, so this is a wallet-side ` +
        `restriction (CSP, URL validation, or capability parsing).`,
    );
  }

  await expect(
    page.getByTestId('backend-probe-result'),
    'probe produced neither a result nor an error',
  ).toBeVisible({ timeout: 25_000 });
  footage.mark('federated-probe-ok', 'independent operator probed successfully');

  // Adopt it.
  const useBtn = page.getByTestId('backend-use-btn');
  await expect(useBtn).toBeVisible({ timeout: 10_000 });
  await useBtn.click();

  // The choice must be DURABLE and must actually be the federated instance. If
  // this shows the default, the user thinks they are self-hosted but is not.
  const current = page.getByTestId('backend-current');
  await expect(current).toBeVisible({ timeout: 15_000 });
  const shownHost = new URL(FED_URL).host;
  await expect(
    current,
    'the wallet did not retain the chosen operator, so it silently fell back',
  ).toContainText(shownHost, { timeout: 15_000 });
  footage.mark('federated-backend-adopted', `wallet now points at ${shownHost}`);

  // Survives a popup reload, which is what "durable" has to mean in practice.
  await page.reload();
  await page.evaluate(() => {
    (globalThis as { location: Location }).location.hash = '#/settings/backend';
  });
  await expect(page.getByTestId('backend-current')).toContainText(shownHost, {
    timeout: 20_000,
  });
  footage.mark('federated-backend-persisted', 'choice survives a reload');
});
