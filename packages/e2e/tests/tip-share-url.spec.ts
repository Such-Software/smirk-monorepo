import { test, expect } from '../fixtures/extension.js';

/**
 * Feature: tips — create a social-tip draft and surface the shareable claim URL.
 *
 * Drives the REAL TipMaker UI (packages/ui/src/components/TipMaker.tsx) end to
 * end: import alice → Home → Tip → compose a PUBLIC BTC tip → submit → assert
 * the success screen surfaces the `https://smirk.cash/tip/<id>#<fragment>`
 * claim URL and a working "Copy link" affordance.
 *
 * Why BTC + public:
 *   - "Public" (the `tip-public-toggle`) is what makes the flow mint a share
 *     URL at all — targeted tips notify the recipient via the bot and never
 *     surface a link (dispatchSocialTip → shareUrl:null for !isPublic).
 *   - BTC/LTC are 0-conf, so `dispatchSocialTip` (extension/src/popup/tip-handler.ts)
 *     returns `shareUrlPending:false` and the URL is live immediately. XMR/WOW/
 *     Grin return `shareUrlPending:true` and would only render the
 *     "waiting for funding to confirm" state, not the URL — a weaker assertion.
 *
 * Determinism: the two-phase create (POST /tips/social) + attach-funding
 * (POST /tips/social/<id>/attach-funding) and the on-chain funding broadcast
 * (POST /wallet/utxo/{utxos,fee,broadcast}) are all stubbed at the network
 * layer so the outcome doesn't hinge on live Electrum/node state or on burning
 * real sats. The share URL is minted CLIENT-SIDE from the backend `tip_id` +
 * the locally-generated URL-fragment key (tip-handler.ts::buildShareUrl), so
 * stubbing the backend still exercises the real URL-composition + success UI.
 *
 * The wallet's own BTC balance is NOT stubbed — it comes from the funded alice
 * wallet via the backend — because TipMaker's client-side "Insufficient
 * balance" gate compares the typed amount against session balance. A tiny
 * amount (2000 sat) keeps us well inside the funded wallet's BTC.
 */

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();
const PASSWORD = 'e2e-test-password-123';

// Deterministic stand-ins the stubbed backend hands back.
const TIP_ID = '11111111-2222-4333-8444-555555555555';
// A plausible confirmed UTXO on alice's BTC address. Segwit (P2WPKH) signing
// only needs txid/vout/value — no prev-tx — so a fabricated outpoint signs
// fine and lets the funding tx build without a live node.
const FAKE_UTXO = {
  txid: 'a'.repeat(64),
  vout: 0,
  value: 200_000, // 0.002 BTC — dwarfs the 2000-sat tip + fee
  height: 800_000,
};
const FAKE_BROADCAST_TXID = 'b'.repeat(64);

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('public BTC tip → success screen surfaces the shareable claim URL', async ({
  context,
  extensionId,
}) => {
  // --- Stub the tip + funding network surface (context-level: covers the
  //     popup page AND the offscreen doc / SW, whichever issues the call). ---
  //
  // Only the *tip funding* endpoints are intercepted. /wallet/utxo/balance is
  // deliberately left alone so Home + the TipMaker balance gate see the real
  // funded balance.
  await context.route('**/api/v1/tips/social', async (route) => {
    // Phase 1: create draft → returns the tip_id the client will bake into
    // the share URL.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tip_id: TIP_ID, status: 'draft' }),
    });
  });
  await context.route('**/api/v1/tips/social/*/attach-funding', async (route) => {
    // Phase 2: attach the (stubbed) funding txid → success flips the tip live.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tip_id: TIP_ID, status: 'pending' }),
    });
  });
  await context.route('**/api/v1/wallet/utxo/utxos', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ utxos: [FAKE_UTXO] }),
    });
  });
  await context.route('**/api/v1/wallet/utxo/fee', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ asset: 'btc', fast: 8, normal: 5, slow: 2 }),
    });
  });
  await context.route('**/api/v1/wallet/utxo/broadcast', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ txid: FAKE_BROADCAST_TXID }),
    });
  });

  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/tip|auth|bootstrap|error|fail|401/i.test(t)) {
      console.log('CONSOLE', m.type(), t.slice(0, 200));
    }
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // --- Onboarding: import alice (proven sequence from onboarding-import.spec) ---
  await page.getByTestId('onboarding-import-btn').click();
  await page.getByTestId('onboarding-import-warning-continue').click();

  const words = MNEMONIC!.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i]!);
  }
  await page.getByTestId('onboarding-import-continue').click();

  await page.getByTestId('onboarding-password-input').fill(PASSWORD);
  await page.getByTestId('onboarding-password-confirm-input').fill(PASSWORD);

  // Submitting the password runs onComplete → bootstrapAuth against the backend.
  // Assert the real auth trigger actually fires against the TEST backend rather
  // than racing a fixed sleep. Requires the offscreen runner to be pointed at
  // VITE_SMIRK_BACKEND_URL (see auth diagnosis / codeChangeNeeded in the task).
  const authFired = page
    .waitForResponse(
      (r) =>
        /127\.0\.0\.1:8080\/api\/v1\/auth\/(extension|check-restore)/.test(r.url()) &&
        r.status() === 200,
      { timeout: 30_000 },
    )
    .catch(() => null);
  await page.getByTestId('onboarding-set-password-submit').click();
  await authFired;

  // Optional Smirk-setup step (username / inject) → finish, if present.
  await page
    .getByTestId('onboarding-setup-finish-btn')
    .click({ timeout: 20_000 })
    .catch(() => {
      /* hasSetupStep === false → skipped straight to Home */
    });

  // Onboarding is gone and Home (with the action row) is up.
  await expect(page.getByTestId('onboarding-import-btn')).toHaveCount(0);
  const tipAction = page.getByTestId('home-action-tip');
  await expect(tipAction).toBeVisible({ timeout: 40_000 });

  // --- Navigate to the Tip composer ---
  await tipAction.click();
  await expect(page.getByTestId('tip-submit-btn')).toBeVisible();

  // Public tip: flip the toggle so the flow mints a share URL (and drops the
  // recipient input — public tips need no username).
  await page.getByTestId('tip-public-toggle').check();

  // Force the funding asset to BTC so the URL is live immediately
  // (shareUrlPending:false). The default asset is largest-balance, which could
  // be XMR/WOW and would only render the pending state.
  await page.getByTestId('tip-asset-dropdown').click();
  await page.getByTestId('tip-asset-option-btc').click();
  await expect(page.getByTestId('tip-asset-dropdown')).toContainText('BTC');

  // Small amount, comfortably inside a funded wallet's BTC balance.
  await page.getByTestId('tip-amount-input').fill('0.00002');

  const submit = page.getByTestId('tip-submit-btn');
  await expect(submit).toBeEnabled();
  await submit.click();

  // --- Meaningful outcome: success screen + the real shareable claim URL ---
  await expect(page.getByTestId('tip-success-heading')).toBeVisible({ timeout: 30_000 });

  const shareUrl = page.getByTestId('tip-share-url');
  await expect(shareUrl).toBeVisible();
  // URL shape: https://smirk.cash/tip/<tipId>#<urlFragmentKey> — the tip_id is
  // the backend's, the fragment is the client-minted claim key.
  await expect(shareUrl).toContainText(`smirk.cash/tip/${TIP_ID}`);
  await expect(shareUrl).toContainText('#');

  // The share affordance is present and copies (not the pending placeholder).
  await expect(page.getByTestId('tip-copy-link-btn')).toBeVisible();
  await expect(page.getByTestId('tip-share-pending')).toHaveCount(0);

  // The tip-id readout confirms the create round-trip landed the backend id.
  await expect(page.getByTestId('tip-id-label')).toContainText(TIP_ID.slice(0, 12));

  // Copy link → button flips to the confirmed state (clipboard write path).
  await page.getByTestId('tip-copy-link-btn').click();
  await expect(page.getByTestId('tip-copy-link-btn')).toContainText('Copied');
});
