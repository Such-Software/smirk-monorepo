import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';

/**
 * Settings + Inbox nav smoke: daemon-free.
 *
 * Two independent, no-daemon nav checks that each of the two lower
 * tabs renders its surface once we're on an unlocked Home. Neither
 * assertion touches the chain daemon or any offscreen request: we
 * click the bottom-nav tab and assert on the tab's rendered chrome.
 *
 *   - Settings tab → the extension's SettingsStub
 *     (packages/extension/src/popup/index.tsx). Its root renders an
 *     `<h2>Settings</h2>` heading and an "Auto-lock wallet after"
 *     control whose "Immediately" option carries a stable testid
 *     (`settings-autolock-immediately`). We assert on both (a stable
 *     heading + a concrete affordance) so the check fails loudly if
 *     the Settings surface stops rendering.
 *   - Inbox tab → the shared InboxTab component
 *     (packages/ui/src/components/InboxTab.tsx). Its root carries
 *     `data-testid="inbox-tab"`, renders an `<h2>Inbox</h2>` heading,
 *     and always shows the "To sign" / "To finalize" sections (empty
 *     for alice, who has no pending Grin exchanges or tips).
 *
 * Auth: we import alice (already-registered) via the shared
 * `importAndUnlock` helper, which returns once a REAL backend balance
 * (WOW 19.79) renders on Home, proving auth WITHOUT waiting on the
 * bootstrap `/auth/extension` POST. That POST fires from the
 * extension's OFFSCREEN document, whose network is invisible to
 * Playwright's page/context response listeners, so any
 * `waitForResponse('/auth/extension')` always times out. See
 * fixtures/onboard.ts for the full rationale.
 *
 * Requires the extension built with VITE_SMIRK_BACKEND_URL pointed at
 * the local backend (dist already is). Source the seeds first:
 *
 *   set -a && . <monorepo>/packages/smoke-tests/secrets/smoke-mnemonics.env && set +a
 */

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('Settings tab renders the settings surface', async ({ context, extensionId }) => {
  const page = await context.newPage();

  // ---- Auth/onboarding: import alice (already-registered) ----
  // Returns once authenticated; auth is proven by alice's real backend
  // balance (WOW 19.79) rendering on Home, never by an offscreen
  // /auth/extension wait.
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });

  // Home is up + bottom nav visible.
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  // ---- Navigate to the Settings tab ----
  await page.getByTestId('nav-tab-settings').click();

  // The SettingsStub heading + the "Immediately" auto-lock option
  // confirm the settings surface rendered. Pure UI assertion: no
  // daemon, no offscreen network.
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('#root')).toContainText('Auto-lock wallet after');
  await expect(page.getByTestId('settings-autolock-immediately')).toHaveCount(1);
});

test('Inbox tab renders the inbox surface', async ({ context, extensionId }) => {
  const page = await context.newPage();

  // ---- Auth/onboarding: import alice (already-registered) ----
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });

  // Home is up + bottom nav visible.
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  // ---- Navigate to the Inbox tab ----
  await page.getByTestId('nav-tab-inbox').click();

  // The InboxTab root container + its heading confirm the inbox surface
  // rendered. The "To sign" / "To finalize" sections always render
  // (empty for alice: no pending Grin exchanges or tips), so we assert
  // on them too for a resilient, daemon-free check.
  await expect(page.getByTestId('inbox-tab')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.locator('#root')).toContainText('To sign');
  await expect(page.locator('#root')).toContainText('To finalize');
});
