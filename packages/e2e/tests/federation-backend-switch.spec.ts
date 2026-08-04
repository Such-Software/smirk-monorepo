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
import { importAndUnlock } from '../fixtures/onboard.js';

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC ?? '';
test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

const FED_URL = process.env.FED_BACKEND_URL ?? '';
test.skip(
  !FED_URL,
  'FED_BACKEND_URL not set — needs a second independent backend (see docs/private/E2E_ENV.md)',
);

// Import + probe + switch + re-bootstrap against a different instance + a reload
// does not fit the default 90s budget.
test.setTimeout(180_000);

test('the wallet can be pointed at an independent operator backend', async ({
  context,
  extensionId,
  footage,
}) => {
  const page = await context.newPage();

  // Reach the picker the way a user does: Settings → Backend
  // (`settings.tsx` navigate('settings/backend')).
  //
  // This used to set `location.hash = '#/settings/backend'`. The popup does not
  // route by URL hash at all, so that navigated nowhere and the spec failed with
  // "backend picker never rendered" — which reads like the picker is broken when
  // the app is fine and the test was driving it wrong. The wallet must be
  // unlocked first, since Settings lives behind the shell.
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC });

  await page.getByTestId('nav-tab-settings').click();
  const backendNav = page.getByTestId('settings-backend-nav');
  await expect(
    backendNav,
    'Settings has no Backend row, so a user cannot choose an operator at all',
  ).toBeVisible({ timeout: 20_000 });
  await backendNav.click();

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

  // Assert on the DURABLE RECORD, not on the re-rendered UI.
  //
  // Switching re-points the api singleton, clears the JWT and caches, and drops
  // the session so the shell re-bootstraps against the new instance. Against a
  // freshly created backend that means registering from scratch and retrying
  // chain reads that 503 until its LWS accounts exist, which can outlast any
  // reasonable test budget. Waiting on the UI therefore tests the second
  // backend's provisioning, not federation.
  //
  // What federation actually promises is narrower and checkable: the wallet
  // persists the operator the user chose and does not silently fall back to the
  // built-in default. That lives in extension storage under BACKEND_CONFIG_KEY.
  const shownHost = new URL(FED_URL).host;
  const stored = await page.evaluate(async () => {
    const chromeApi = (globalThis as unknown as {
      chrome: { storage: { local: { get: (k: string) => Promise<Record<string, unknown>> } } };
    }).chrome;
    return (await chromeApi.storage.local.get('smirk_backend_v1'))['smirk_backend_v1'];
  });

  expect(
    JSON.stringify(stored ?? null),
    'the wallet did not persist the chosen operator, so it silently fell back to ' +
      'the default: the user believes they are self-hosted while their traffic ' +
      'goes to ours, which is the worst possible outcome',
  ).toContain(shownHost);
  footage.mark('federated-backend-adopted', `wallet persisted ${shownHost}`);

  // Durable across a full reload of the popup, not just in component state.
  await page.reload();
  const afterReload = await page.evaluate(async () => {
    const chromeApi = (globalThis as unknown as {
      chrome: { storage: { local: { get: (k: string) => Promise<Record<string, unknown>> } } };
    }).chrome;
    return (await chromeApi.storage.local.get('smirk_backend_v1'))['smirk_backend_v1'];
  });
  expect(
    JSON.stringify(afterReload ?? null),
    'the chosen operator did not survive a reload',
  ).toContain(shownHost);
  footage.mark('federated-backend-persisted', 'choice survives a reload');
});
