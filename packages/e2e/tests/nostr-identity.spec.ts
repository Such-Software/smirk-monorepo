import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';

/**
 * nostr-identity — Settings → link / login-with-Nostr identity screen.
 *
 * Drives the REAL extension UI against the local smirk-backend-core:
 *   1. import alice via onboarding → authenticated returning user
 *      (no PoW, no payment gate; auth fires against 127.0.0.1:8080)
 *   2. open Settings (bottom-nav) and assert the settings surface renders
 *   3. reach the Nostr-identity entry point and assert the identity UI
 *      renders in its EXPECTED state
 *
 * Auth signal (WHY the helper, not a response wait): bootstrap-auth
 * (POST /auth/extension) fires from the extension's OFFSCREEN document,
 * whose network is INVISIBLE to Playwright's page/context response
 * listeners — `waitForResponse('/auth/extension')` there ALWAYS times
 * out (the root cause of the previous failures). `importAndUnlock`
 * instead detects auth by a real backend balance rendering on Home
 * (alice's WOW 19.79), which only appears when the offscreen token is
 * valid on THIS backend. Any response we DO assert on must originate
 * from the POPUP page (e.g. the wallet balance route), never offscreen.
 *
 * Feature status (Identity Phase 1): the backend (/auth/nostr[/link],
 * NIP-98 verify) and @smirk/core (api.linkNostr / api.nostrLogin,
 * buildNip98Event, deriveNostrIdentity) are complete, but the
 * per-shell Settings link/login/rotation UI is the documented REMAINING
 * client work that rides with v0.3.0 — as of this writing NO Nostr
 * identity entry point exists in packages/extension/src or packages/ui/src
 * (the only "Nostr" string in the client is the SwapTab P2P orderbook
 * provider, which is NOT this feature). We therefore:
 *   - assert the Settings surface (the account/identity home) is reachable
 *     and renders, then
 *   - detect the Nostr identity entry point and, when it is present,
 *     assert the identity UI renders in its expected state — WITHOUT
 *     asserting a successful link round-trip, because the backend's
 *     /auth/nostr/link currently fails closed (nonce store stubbed).
 *   - when the entry point has not landed yet, test.skip() at runtime
 *     with a clear message (a truthful pass, not a false green), so this
 *     spec exercises the real screen automatically once it ships.
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('Settings → Nostr identity screen is reachable and renders', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();

  // Log backend traffic that ORIGINATES FROM THE POPUP PAGE (balance,
  // socials, etc.). Offscreen bootstrap-auth is intentionally NOT waited
  // on anywhere — it is invisible here. This listener is diagnostic only.
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('127.0.0.1:8080')) {
      console.log('BACKEND', r.status(), u.split('8080')[1] ?? u);
    }
  });

  // ── 1. onboarding: import alice → authenticated (real balance rendered) ──
  // The helper drives the full import flow and returns only once a real
  // backend balance renders on Home (auth OK). No offscreen response wait.
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });

  // ── 2. open Settings via the bottom nav and assert it renders ───────────
  await page.getByTestId('nav-tab-settings').click();
  // The settings surface is the account/identity home. Its lock button is
  // the stable anchor (mirrors settings-sent-tips-nav / -lock-now-btn).
  await expect(page.getByTestId('settings-lock-now-btn')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('#root')).toContainText(/Settings/i, {
    timeout: 10_000,
  });

  // ── 3. reach the Nostr-identity entry point ─────────────────────────────
  // Expected testids once the client UI lands (mirroring the existing
  // settings-sent-tips-nav / settings-lock-now-btn conventions):
  //   settings-nostr-nav   — SettingsNavRow opening the Nostr identity screen
  //   nostr-link-btn       — "Link Nostr identity" action
  //   nostr-npub           — element showing the derived/linked npub
  //   nostr-linked-badge   — confirmation the npub is linked
  // The SwapTab "P2P (Nostr orderbook)" provider is a swap surface, NOT the
  // identity feature — so we key off the Settings-scoped testids/text, not a
  // bare /Nostr/ page match, to avoid a false positive from that provider.
  const nostrNav = page.getByTestId('settings-nostr-nav');
  const nostrHeading = page.getByRole('heading', { name: /Nostr|npub|identity/i });
  const hasNostrEntry =
    (await nostrNav.count()) > 0 || (await nostrHeading.count()) > 0;

  test.skip(
    !hasNostrEntry,
    'Settings → Nostr link/login identity UI not present in this build ' +
      '(Identity Phase 1 client UI not yet landed; backend + @smirk/core are ' +
      'ready). Rebuild once the settings-nostr-* entry point ships.',
  );

  // Entry point present → open the identity screen.
  if ((await nostrNav.count()) > 0) {
    await nostrNav.click();
  }

  // ── 4. assert the identity UI renders in its EXPECTED state ─────────────
  // Assert on the UI, NOT a link round-trip: the backend /auth/nostr/link
  // currently fails closed (nonce store stubbed), so a link attempt does
  // not succeed. What we CAN assert is that the identity screen renders and
  // surfaces the seed-derived identity (npub / link affordance).
  const npub = page.getByTestId('nostr-npub');
  const linkBtn = page.getByTestId('nostr-link-btn');
  const badge = page.getByTestId('nostr-linked-badge');

  if ((await npub.count()) > 0) {
    await expect(npub).toContainText(/npub1[0-9a-z]{20,}/i, { timeout: 10_000 });
  } else if ((await linkBtn.count()) > 0) {
    await expect(linkBtn).toBeVisible({ timeout: 10_000 });
  } else if ((await badge.count()) > 0) {
    await expect(badge).toBeVisible({ timeout: 10_000 });
  } else {
    // Screen rendered under different testids — assert the derived npub or a
    // recognizable identity affordance is on screen.
    await expect(page.locator('#root')).toContainText(
      /npub1[0-9a-z]{20,}|Link.*Nostr|Nostr.*identity/i,
      { timeout: 10_000 },
    );
  }
});
