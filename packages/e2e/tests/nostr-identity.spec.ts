import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import { getCapabilities } from '../fixtures/capabilities.js';

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
 * Feature status (Identity Phase 1 — COMPLETE): the backend
 * (/auth/nostr/link-challenge + /auth/nostr/link with an atomic single-use
 * nonce, /auth/nostr login, NIP-98 verify) and @smirk/core (api.linkNostr /
 * api.nostrLogin / api.getMe, buildSignedActionEvent, deriveNostrIdentity) are
 * wired, and the Settings → Nostr identity screen has landed
 * (settings-nostr-nav → settings-nostr-screen with nostr-npub / nostr-link-btn /
 * nostr-linked-badge / account rotation). This spec now drives a REAL link
 * round-trip: import alice → Settings → Nostr identity → Link → linked badge.
 * It requires FEATURE_NOSTR_IDENTITY=on and PUBLIC_API_URL set to the same
 * origin the extension is built against (so the NIP-98 `u` tag validates); it
 * self-skips via /capabilities when the feature is off.
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('Settings → Nostr identity screen is reachable and renders', async ({
  context,
  extensionId,
}) => {
  // Self-adapt: the link/login round-trip needs the backend's nostr_identity
  // feature ON. When it's off, skip early (before any onboarding work) with an
  // accurate reason instead of relying on the downstream UI-presence skip.
  const caps = await getCapabilities();
  test.skip(
    !caps.features.nostr_identity,
    'backend feature nostr_identity is off (/capabilities features.nostr_identity=false) — Nostr link/login N/A on this config',
  );

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

  // ── 3. open the Nostr-identity screen (Settings → Nostr identity) ────────
  await page.getByTestId('settings-nostr-nav').click();
  await expect(page.getByTestId('settings-nostr-screen')).toBeVisible({
    timeout: 10_000,
  });

  // The seed-derived npub renders (client-side derivation, no network).
  await expect(page.getByTestId('nostr-npub')).toContainText(/npub1[0-9a-z]{20,}/i, {
    timeout: 10_000,
  });

  // ── 4. exercise a REAL link round-trip against the backend ───────────────
  // linkNostr: GET /auth/nostr/link-challenge → sign the action over the empty-
  // body request descriptor → POST /auth/nostr/link. On success the linked badge
  // renders. Idempotent across runs: if alice's npub is already linked, getMe
  // surfaces it and the badge is already present (no button to click).
  const badge = page.getByTestId('nostr-linked-badge');
  if ((await badge.count()) === 0) {
    await page.getByTestId('nostr-link-btn').click();
  }
  await expect(badge).toBeVisible({ timeout: 20_000 });
});
