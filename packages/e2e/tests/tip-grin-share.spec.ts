import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import { getCapabilities } from '../fixtures/capabilities.js';

/**
 * Feature: tips (Grin voucher): create a PUBLIC Grin voucher tip and land on
 * the success screen in its `shareUrlPending` state.
 *
 * Drives the REAL TipMaker composer (packages/ui/src/components/TipMaker.tsx)
 * and the REAL Grin voucher builder (tip-handler.ts::createGrinTip →
 * @smirk/wasm grin_create_grin_voucher). Import alice → Home → Tip → flip
 * PUBLIC → pick GRIN → amount → submit.
 *
 * Why the assertion is the PENDING state, not a live URL:
 *   Grin is confirmation-gated, so `createGrinTip` returns
 *   `shareUrlPending:true` (tip-handler.ts) and TipSuccess renders the
 *   "⏳ Waiting for funding to confirm" affordance (`tip-share-pending`);
 *   it deliberately HIDES the smirk.cash/tip URL + Copy-link button until
 *   funding buries past the confirmation gate. (Contrast BTC/LTC in
 *   tip-share-url.spec.ts, which are 0-conf and surface the live URL now.)
 *   This is the honest, real behavior of the Grin path.
 *
 * ─── Why the Grin scan is stubbed with a SPECIFIC commitment ───
 * The Grin balance has no custodial endpoint; it's recomputed client-side
 * from `POST /wallet/grin/scan` (wallet-flow.ts::fetchGrinBalance). Locally
 * the grin node isn't tunneled, so a real scan 503s and the balance gate
 * (parsedAmount > balance) blocks submit. So we stub the scan to expose one
 * spendable 5-GRIN output.
 *
 * BUT the voucher builder is non-custodial: grin_create_grin_voucher →
 * derive_input_blind_with_fallback (crates/grin-ext) *cryptographically
 * verifies* every input commitment by re-deriving the Pedersen commitment
 * from alice's own extended key at the output's BIP32 path + amount and
 * requiring an exact match (a fabricated commitment fails with "input
 * commitment mismatch"). There is no live scan of alice's on-chain Grin
 * outputs here, and the switch-commitment blind derivation isn't
 * JS-reproducible / wasm-exported, so the stubbed output MUST carry
 * alice's REAL commitment for the chosen (path, amount).
 *
 * GRIN_INPUT_COMMIT below is exactly that: alice's real `v3+Regular+d4`
 * Pedersen commitment at path [0,0,5,0] for a 5_000_000_000-nanogrin input.
 * It's deterministic from alice's seed. To regenerate (e.g. if the smoke
 * alice seed rotates): run this spec with any junk 66-hex commitment, and
 * the thrown "input commitment mismatch …" error lists the correct
 * `v3+Regular+d4 → <commit>` candidate: paste that value here. The
 * canonical `key_id` (depth-4 [0,0,5,0]) lets resolveGrinSpendable recover
 * the path directly (grin-flows.ts::parseGrinCanonicalKeyId), so it never
 * has to run the wasm identify search over a non-existent chain.
 */

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();
const PASSWORD = 'e2e-test-password-123';

// Deterministic stand-in the stubbed backend hands back for the tip row.
const TIP_ID = '11111111-2222-4333-8444-555555555555';

// Spendable Grin input we expose to the composer. value MUST stay pinned to
// GRIN_INPUT_VALUE and commit MUST stay GRIN_INPUT_COMMIT together: the
// commitment is alice's real derivation for exactly that path+value.
const GRIN_INPUT_VALUE = 5_000_000_000; // 5 GRIN (9 decimals)
// Canonical Smirk key_id → path [0,0,5,0] (depth=04, p0=p1=p3=0, p2=5).
const GRIN_KEY_ID = '04' + '00000000' + '00000000' + '00000005' + '00000000';
// alice's REAL v3+Regular Pedersen commitment at path [0,0,5,0], value 5 GRIN.
const GRIN_INPUT_COMMIT = '0892fa927c04a225f92080b93d98eb5ade7316d05f83ac8afd321e02ad51b9936e';

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('public GRIN voucher tip → success screen in the shareUrlPending state', async ({
  context,
  extensionId,
}) => {
  const caps = await getCapabilities();
  test.skip(
    !caps.chains.grin?.enabled,
    'grin disabled on this backend (/capabilities chains.grin)',
  );

  // --- Stub the tip create + funding surface (context-level: covers the
  //     popup page AND any SW/offscreen caller). ---
  let createAsset: string | undefined;
  let createHadGrinCommitment = false;
  let grinBroadcastCalled = false;

  await context.route('**/api/v1/tips/social', async (route) => {
    // Phase 1: create draft. Capture the body so we can assert the composer
    // really took the GRIN voucher branch (asset:'grin' + grin_commitment).
    try {
      const body = route.request().postDataJSON() as {
        asset?: string;
        grin_commitment?: string;
      };
      createAsset = body?.asset;
      createHadGrinCommitment = typeof body?.grin_commitment === 'string';
    } catch {
      /* body parse best-effort */
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tip_id: TIP_ID, status: 'draft' }),
    });
  });
  await context.route('**/api/v1/tips/social/*/attach-funding', async (route) => {
    // Phase 2: attach the (stubbed) funding id → tip goes pending_confirmation.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tip_id: TIP_ID, status: 'pending_confirmation' }),
    });
  });
  await context.route('**/api/v1/tips/social/*/cancel', async (route) => {
    // Safety net: if any step failed the handler cancels the draft. We don't
    // expect this on the happy path, but stub it so a cancel can't 404-noise.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  // Grin scan (balance source of truth): expose one mature, spendable 5-GRIN
  // output carrying alice's real commitment + a canonical key_id.
  await context.route('**/api/v1/wallet/grin/scan', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        outputs: [
          {
            commit: GRIN_INPUT_COMMIT,
            value: GRIN_INPUT_VALUE,
            height: 100,
            mmr_index: 1,
            is_coinbase: false,
            lock_height: 0,
            key_id: GRIN_KEY_ID,
            n_child: 5,
            spendable: true,
          },
        ],
        total_balance: GRIN_INPUT_VALUE,
        last_pmmr_index: 1,
      }),
    });
  });
  // Chain-tip map: needed so the 5-GRIN output reads as MATURE (tip ≥ height),
  // otherwise it's counted "locked" and the balance gate blocks submit. High
  // heights are always maturity-safe. (Grin tip only; other assets' confirmed
  // balances come from their own endpoints, not this map.)
  await context.route('**/api/v1/wallet/heights', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        btc: 5_000_000,
        ltc: 20_000_000,
        xmr: 20_000_000,
        wow: 20_000_000,
        grin: 20_000_000,
      }),
    });
  });
  // Voucher broadcast: stubbed so no real Grin tx hits the wire. Flag it so we
  // can assert the voucher was actually built + broadcast (not short-circuited).
  await context.route('**/api/v1/wallet/grin/broadcast', async (route) => {
    grinBroadcastCalled = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC!, password: PASSWORD });

  // --- Navigate to the Tip composer ---
  await page.getByTestId('home-action-tip').click();
  await expect(page.getByTestId('tip-submit-btn')).toBeVisible();

  // Public tip: on a public-only backend the composer already defaults to a
  // public share-URL tip (the targeted toggle is hidden, since the backend can't
  // serve targeted tips), so there's nothing to flip: the flow mints a share
  // URL / claim link out of the box.

  // Force the funding asset to GRIN (default is largest-balance).
  await page.getByTestId('tip-asset-dropdown').click();
  await page.getByTestId('tip-asset-option-grin').click();
  await expect(page.getByTestId('tip-asset-dropdown')).toContainText('GRIN');

  // Small amount, comfortably inside the 5-GRIN spendable input (+ fee + change).
  await expect(page.locator('#root')).toContainText('Available: 5 GRIN');
  await page.getByTestId('tip-amount-input').fill('0.5');

  const submit = page.getByTestId('tip-submit-btn');
  await expect(submit).toBeEnabled();
  await submit.click();

  // --- Meaningful outcome: success screen in the Grin "pending" state ---
  await expect(page.getByTestId('tip-success-heading')).toBeVisible({ timeout: 40_000 });

  // Grin is confirmation-gated → the success screen shows the "waiting for
  // funding to confirm" affordance, NOT a live smirk.cash claim URL.
  const pending = page.getByTestId('tip-share-pending');
  await expect(pending).toBeVisible();
  await expect(pending).toContainText(/Waiting for funding to confirm/i);

  // No live URL + no copy-link button for Grin (unlike 0-conf BTC/LTC).
  await expect(page.getByTestId('tip-share-url')).toHaveCount(0);
  await expect(page.getByTestId('tip-copy-link-btn')).toHaveCount(0);

  // The tip-id readout confirms the create round-trip landed the backend id.
  await expect(page.getByTestId('tip-id-label')).toContainText(TIP_ID.slice(0, 12));

  // The composer really took the Grin voucher branch and broadcast the tx:
  // proves this is the genuine voucher path, not an incidental success screen.
  expect(createAsset, 'create POST asset should be grin').toBe('grin');
  expect(createHadGrinCommitment, 'create POST should carry grin_commitment').toBe(true);
  expect(grinBroadcastCalled, 'voucher tx should have been broadcast').toBe(true);
});
