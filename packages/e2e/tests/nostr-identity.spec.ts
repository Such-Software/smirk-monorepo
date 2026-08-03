import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import { getCapabilities } from '../fixtures/capabilities.js';

/**
 * nostr-identity: Settings → Nostr identities (the P2 multi-identity switcher).
 *
 * Drives the REAL extension UI against the local smirk-backend-core:
 *   1. import alice via onboarding → authenticated returning user
 *   2. open Settings → Nostr identities
 *   3. exercise the switcher CRUD: the active npub renders, add a BURNER
 *      identity, switch to it (active npub changes), switch back, remove it
 *   4. a REAL link round-trip for the active identity (NIP-98 link → linked badge)
 *
 * Auth signal (WHY the helper, not a response wait): bootstrap-auth
 * (POST /auth/extension) fires from the extension's OFFSCREEN document, whose
 * network is INVISIBLE to Playwright; `waitForResponse` there always times out.
 * `importAndUnlock` detects auth by a real backend balance rendering on Home
 * (alice's WOW 19.79). Any response we assert on must originate from the POPUP.
 *
 * Requires FEATURE_NOSTR_IDENTITY=on; self-skips via /capabilities when off.
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('Settings → Nostr identities: switcher CRUD + link round-trip', async ({
  context,
  extensionId,
}) => {
  const caps = await getCapabilities();
  test.skip(
    !caps.features.nostr_identity,
    'backend feature nostr_identity is off — Nostr link/login N/A on this config',
  );

  const page = await context.newPage();
  // Auto-accept the "remove identity" confirm() dialog when it fires.
  page.on('dialog', (d) => void d.accept());

  // ── 1. onboarding: import alice → authenticated (real balance rendered) ──
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });

  // ── 2. Settings → Nostr identities ──────────────────────────────────────
  await page.getByTestId('nav-tab-settings').click();
  await expect(page.getByTestId('settings-lock-now-btn')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('settings-nostr-nav').click();
  await expect(page.getByTestId('settings-nostr-screen')).toBeVisible({ timeout: 10_000 });

  // ── 3. switcher renders: the active (seed) identity's FULL npub + the
  //       add/import affordances are all present ───────────────────────────
  const activeNpub = page.getByTestId('nostr-npub');
  await expect(activeNpub).toContainText(/npub1[0-9a-z]{20,}/i, { timeout: 10_000 });
  const seedNpub = (await activeNpub.textContent())?.trim();
  await expect(page.getByTestId('nostr-add-burner')).toBeVisible();
  await expect(page.getByTestId('nostr-add-derived')).toBeVisible();
  await expect(page.getByTestId('nostr-import-nsec')).toBeVisible();

  const idRows = page.locator('[data-testid^="nostr-identity-"]');
  await expect(idRows).toHaveCount(1); // just the seed identity to start

  // ── add a BURNER (random, seed-independent) → a second row appears ──────
  await page.getByTestId('nostr-add-burner').click();
  await expect(idRows).toHaveCount(2);
  await expect(page.locator('#root')).toContainText(/burner/i);

  // ── switch to the burner → the active npub changes to it ────────────────
  await page.locator('[data-testid^="nostr-switch-"]').first().click();
  await expect
    .poll(async () => (await activeNpub.textContent())?.trim(), { timeout: 10_000 })
    .not.toEqual(seedNpub);

  // ── switch back to the seed identity → active npub is the seed one again ─
  await page.locator('[data-testid^="nostr-switch-"]').first().click();
  await expect
    .poll(async () => (await activeNpub.textContent())?.trim(), { timeout: 10_000 })
    .toEqual(seedNpub);

  // ── remove the burner → back to a single identity ───────────────────────
  await page.locator('[data-testid^="nostr-remove-"]').first().click();
  await expect(idRows).toHaveCount(1);

  // ── 4. REAL link round-trip for the active (seed) identity ──────────────
  const badge = page.getByTestId('nostr-linked-badge');
  if ((await badge.count()) === 0) {
    await page.getByTestId('nostr-link-btn').click();
  }
  await expect(badge).toBeVisible({ timeout: 20_000 });
});
