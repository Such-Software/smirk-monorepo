import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';

/**
 * receive — drive the REAL Receive surface from Home: open the Receive
 * screen, pick XMR on the "Choose asset" picker, and assert the derived
 * Monero receive address renders (plus the Copy affordance).
 *
 * Auth/onboarding: import the ALREADY-REGISTERED wallet alice via the
 * shared `importAndUnlock` helper. It drives the full onboarding-import
 * flow and returns once the wallet is authenticated — detected by a REAL
 * backend balance rendering on Home (alice's WOW 19.79), NOT by waiting
 * on the bootstrap `/auth/extension` POST (that fires from the extension's
 * OFFSCREEN document and is invisible to Playwright — any wait on it times
 * out).
 *
 * Daemon-independent: the receive address is derived CLIENT-SIDE from the
 * wallet keys (`resolveAddressForAsset` → `wallet.addresses.xmr` in the
 * popup shell), so this screen renders with no backend/daemon round-trip.
 * The picker and address are therefore capturable UI — no offscreen
 * network is involved past the initial auth that importAndUnlock covers.
 *
 * Preconditions:
 *   - extension built with VITE_SMIRK_BACKEND_URL=http://127.0.0.1:8080/api/v1
 *     and VITE_SMIRK_API_STYLE=namespaced (dist already is — do NOT rebuild).
 *   - seed env sourced:
 *       set -a && . <monorepo>/packages/smoke-tests/secrets/smoke-mnemonics.env && set +a
 *
 * UI map (verified against packages/ui/src/components/ReceiveScreen.tsx):
 *   Home action bar → `home-action-receive`      (UnifiedBalance.tsx)
 *   Picker step (asset)  → `receive-asset-xmr`    (PickAsset)
 *   Address step         → `receive-address` (mono) + `receive-copy-btn`
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('Receive → XMR → derived address renders (offline, no daemon)', async ({
  context,
  extensionId,
  footage,
}) => {
  const page = await context.newPage();

  // --- Onboarding: import alice (returning user → no PoW, no gate) -------
  // Returns once authenticated; auth is proven by alice's real backend
  // balance (WOW 19.79) rendering on Home — never by an offscreen
  // /auth/extension wait.
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });

  // Onboarding gone; Home is up + authenticated, and the home tab is the
  // active tab by default post-onboard.
  await expect(page.getByTestId('onboarding-import-btn')).toHaveCount(0);
  await expect(page.getByTestId('nav-tab-home')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('home-action-receive')).toBeVisible({ timeout: 40_000 });

  // --- Open Receive → Choose asset picker -------------------------------
  await page.getByTestId('home-action-receive').click();

  // The first Receive screen is the "Choose asset" picker (Home route sets
  // no initialAssetId). Header reads "Choose asset"; XMR is a receivable
  // asset row.
  await expect(page.locator('#root')).toContainText('Choose asset', { timeout: 15_000 });
  const xmrPick = page.getByTestId('receive-asset-xmr');
  await expect(xmrPick).toBeVisible({ timeout: 15_000 });
  await xmrPick.click();

  // --- Address step: derived XMR address renders ------------------------
  // The address is derived client-side, so it must appear even fully
  // offline. Assert it's visible, not the "Loading address…" placeholder,
  // and is a non-trivial Monero address (standard XMR addresses are 95
  // chars; we require > 90 to stay resilient).
  const addressEl = page.getByTestId('receive-address');
  await expect(addressEl).toBeVisible({ timeout: 30_000 });
  await expect(addressEl).not.toHaveText('Loading address…');
  const addrText = (await addressEl.innerText()).trim();
  expect(addrText.length).toBeGreaterThan(90);

  // The Copy affordance is present (onCopy is wired in the shell).
  await expect(page.getByTestId('receive-copy-btn')).toBeVisible({ timeout: 15_000 });
  footage.mark('receive-address-shown', 'XMR receive address + copy button visible');

  console.log('RECEIVE_XMR_ADDR len=', addrText.length, 'prefix=', addrText.slice(0, 6));
});
