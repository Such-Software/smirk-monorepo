import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import { encodeNpub, generateBurnerIdentity, hexToBytes, shortNpub } from '@smirk/core';
import type { BrowserContext } from '@playwright/test';

/**
 * Feature: tips. Create a social-tip draft and surface the shareable claim URL.
 *
 * Drives the REAL TipMaker UI (packages/ui/src/components/TipMaker.tsx) end to
 * end: import alice → Home → Tip → compose a PUBLIC BTC tip → submit → assert
 * the success screen surfaces the `https://smirk.cash/tip/<id>#<fragment>`
 * claim URL and a working "Copy link" affordance.
 *
 * Why BTC + public:
 *   - Leaving the recipient empty makes a link tip, the kind that surfaces its
 *     share URL. A person tip delivers the same claim key to an npub in a gift
 *     wrap instead, and shows the link only as a fallback.
 *   - BTC/LTC are 0-conf, so `dispatchSocialTip` (extension/src/popup/tip-handler.ts)
 *     returns `shareUrlPending:false` and the URL is live immediately. XMR/WOW/
 *     Grin return `shareUrlPending:true` and would only render the
 *     "waiting for funding to confirm" state, not the URL: a weaker assertion.
 *
 * Determinism: the two-phase create (POST /tips/social) + attach-funding
 * (POST /tips/social/<id>/attach-funding) and the on-chain funding broadcast
 * (POST /wallet/utxo/{utxos,fee,broadcast}) are all stubbed at the network
 * layer so the outcome doesn't hinge on live Electrum/node state or on burning
 * real sats. The share URL is minted CLIENT-SIDE from the backend `tip_id` +
 * the locally-generated URL-fragment key (tip-handler.ts::buildShareUrl), so
 * stubbing the backend still exercises the real URL-composition + success UI.
 *
 * The wallet's own BTC balance is NOT stubbed (it comes from the funded alice
 * wallet via the backend) because TipMaker's client-side "Insufficient
 * balance" gate compares the typed amount against session balance. A tiny
 * amount (2000 sat) keeps us well inside the funded wallet's BTC.
 *
 * Both scenarios also check privacy properties of the v0.3.1 composer: the
 * claim key in the link's fragment never reaches a server, and a person tip's
 * message never reaches one in the clear. The second scenario is a tip to an
 * npub whose gift-wrap delivery fails after funding (every relay socket on the
 * page refuses): it must still read as a funded tip, with a warning and the
 * share link as the fallback. The live lane (tests/live/c-targeted-tips) covers
 * real delivery.
 */

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();
const PASSWORD = 'e2e-test-password-123';

// Deterministic stand-ins the stubbed backend hands back.
const TIP_ID = '11111111-2222-4333-8444-555555555555';
// A plausible confirmed UTXO on alice's BTC address. Segwit (P2WPKH) signing
// only needs txid/vout/value (no prev-tx), so a fabricated outpoint signs
// fine and lets the funding tx build without a live node.
const FAKE_UTXO = {
  txid: 'a'.repeat(64),
  vout: 0,
  value: 200_000, // 0.002 BTC: dwarfs the 2000-sat tip + fee
  height: 800_000,
};
const FAKE_BROADCAST_TXID = 'b'.repeat(64);

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('public BTC tip → success screen surfaces the shareable claim URL', async ({
  context,
  extensionId,
  footage,
}) => {
  // Every request the browser makes during the flow, kept in memory only: the
  // claim key in the link's fragment must never reach any server.
  const outbound: string[] = [];
  context.on('request', (request) => outbound.push(`${request.url()}\n${request.postData() ?? ''}`));
  const captured: { create?: Record<string, unknown> } = {};
  // --- Stub the tip + funding network surface (context-level: covers the
  //     popup page AND the offscreen doc / SW, whichever issues the call). ---
  //
  // Only the *tip funding* endpoints are intercepted. /wallet/utxo/balance is
  // deliberately left alone so Home + the TipMaker balance gate see the real
  // funded balance.
  await context.route('**/api/v1/tips/social', async (route) => {
    // Phase 1: create draft → returns the tip_id the client will bake into
    // the share URL.
    captured.create = route.request().postDataJSON() as Record<string, unknown>;
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

  // A link tip: leave the recipient empty. The v0.3.1 composer says so, offers
  // no message (the backend stores none for a link tip), and offers the three
  // reclaim dates with 7 days preselected.
  await expect(page.getByTestId('tip-recipient-input')).toHaveValue('');
  await expect(page.getByTestId('tip-recipient-hint')).toContainText('Leave empty to make a link anyone can claim');
  await expect(page.getByTestId('tip-memo-input')).toHaveCount(0);
  for (const days of [1, 7, 30]) await expect(page.getByTestId(`tip-expiry-${days}d`)).toBeVisible();
  await expect(page.getByTestId('tip-submit-btn')).toHaveText('Create tip link');

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
  await expect(page.getByTestId('tip-success-heading')).toHaveText('Tip link created', { timeout: 30_000 });
  await expect(page.getByTestId('tip-success-detail')).toContainText('Anyone with the link can claim it');
  await expect(page.getByTestId('tip-delivery-warning')).toHaveCount(0);

  const shareUrl = page.getByTestId('tip-share-url');
  await expect(shareUrl).toBeVisible();
  // URL shape: https://smirk.cash/tip/<tipId>#<urlFragmentKey>; the tip_id is
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
  footage.mark('tip-link-copied', 'shareable claim URL created and copied');

  // The create call registered a public tip by its key hash and carried no
  // message, and the claim key never left the browser.
  const createBody = captured.create;
  expect(createBody, 'the composer created the tip on the backend').toBeDefined();
  expect(createBody!.is_public).toBe(true);
  expect(createBody!.asset).toBe('btc');
  expect(createBody!.amount).toBe(2_000);
  expect(typeof createBody!.claim_key_hash).toBe('string');
  expect('memo' in createBody!).toBe(false);
  const fragment = ((await shareUrl.textContent()) ?? '').split('#')[1] ?? '';
  expect(fragment.length).toBeGreaterThan(20);
  expect(outbound.some((entry) => entry.includes(fragment)), 'the claim key reached a server').toBe(false);
});

/** Stub tip creation and BTC funding so no real sats move (see the header). */
async function stubTipFunding(context: BrowserContext): Promise<{ bodies: string[] }> {
  const bodies: string[] = [];
  context.on('request', (request) => bodies.push(`${request.url()}\n${request.postData() ?? ''}`));
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await context.route('**/api/v1/tips/social', (route) => route.fulfill(json({ tip_id: TIP_ID, status: 'draft' })));
  await context.route('**/api/v1/tips/social/*/attach-funding', (route) =>
    route.fulfill(json({ tip_id: TIP_ID, status: 'pending' })),
  );
  await context.route('**/api/v1/wallet/utxo/utxos', (route) => route.fulfill(json({ utxos: [FAKE_UTXO] })));
  await context.route('**/api/v1/wallet/utxo/fee', (route) =>
    route.fulfill(json({ asset: 'btc', fast: 8, normal: 5, slow: 2 })),
  );
  await context.route('**/api/v1/wallet/utxo/broadcast', (route) => route.fulfill(json({ txid: FAKE_BROADCAST_TXID })));
  return { bodies };
}

test('npub tip whose delivery fails → funded, warned, and the share link offered as the fallback', async ({
  context,
  extensionId,
}) => {
  const { bodies } = await stubTipFunding(context);
  // A recipient that is a fresh, valid npub. Only its public half is used.
  const recipient = generateBurnerIdentity();
  recipient.privateKey.fill(0);
  const display = shortNpub(encodeNpub(hexToBytes(recipient.pubkeyHex)));
  const memo = 'e2e message that rides only in the gift wrap';

  const page = await context.newPage();
  // Every relay socket on this page refuses every event, so delivery fails
  // after funding whichever relay the backend under test advertises (and
  // with none advertised, delivery fails before any socket opens).
  await page.routeWebSocket(/.*/, (ws) => {
    ws.onMessage((message) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(message));
      } catch {
        return;
      }
      if (Array.isArray(frame) && frame[0] === 'EVENT') {
        ws.send(JSON.stringify(['OK', (frame[1] as { id?: string })?.id ?? '', false, 'blocked: e2e']));
      } else if (Array.isArray(frame) && frame[0] === 'REQ') {
        ws.send(JSON.stringify(['EOSE', frame[1]]));
      }
    });
  });
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC!, password: PASSWORD });

  await page.getByTestId('home-action-tip').click();
  await page.getByTestId('tip-asset-dropdown').click();
  await page.getByTestId('tip-asset-option-btc').click();
  await page.getByTestId('tip-recipient-input').fill(recipient.npub);
  await expect(page.getByTestId('tip-recipient-hint')).toContainText(`Only ${display} can claim this tip`);
  // A person tip carries a message; a link tip cannot.
  await expect(page.getByTestId('tip-memo-input')).toBeVisible();
  await page.getByTestId('tip-memo-input').fill(memo);
  await page.getByTestId('tip-amount-input').fill('0.00002');
  await page.getByTestId('tip-expiry-30d').click();
  const submit = page.getByTestId('tip-submit-btn');
  await expect(submit).toHaveText(`Send to ${display}`);
  await expect(submit).toBeEnabled();
  await submit.click();

  // Funds left the wallet before delivery ran, so this is a funded tip.
  await expect(page.getByTestId('tip-success-heading')).toHaveText('Tip sent', { timeout: 30_000 });
  await expect(page.getByTestId('tip-error')).toHaveCount(0);
  const warning = page.getByTestId('tip-delivery-warning');
  await expect(warning).toContainText(display);
  await expect(warning).toContainText('Tips, sent');
  const link = page.getByTestId('tip-share-url');
  await expect(link).toContainText(`smirk.cash/tip/${TIP_ID}#`);
  await expect(page.getByTestId('tip-copy-link-btn')).toBeVisible();
  await expect(page.getByTestId('tip-share-pending')).toHaveCount(0);

  // The message never reached any server in the clear, and neither did the
  // claim key in the fallback link.
  const fragment = ((await link.textContent()) ?? '').split('#')[1] ?? '';
  expect(fragment.length).toBeGreaterThan(20);
  expect(bodies.some((entry) => entry.includes(memo)), 'the message reached a server').toBe(false);
  expect(bodies.some((entry) => entry.includes(fragment)), 'the claim key reached a server').toBe(false);
});
