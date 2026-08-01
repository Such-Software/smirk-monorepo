import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';

/**
 * send-fee-btc — regression guard for the namespaced BTC/LTC fee estimate.
 *
 * THE BUG: against a namespaced backend (smirk-backend-core) the client used to
 * POST the FLAT `{asset}` body to the fee route and 422, so `estimateFee` failed,
 * the Compose fee tiers never populated, `selectedFeeSat` stayed null, and the
 * "Continue to review" button was permanently disabled — BTC/LTC Send was dead.
 * The fix (packages/core/src/api/wallet-utxo.ts::estimateFee) translates the
 * namespaced dialect: POST `{asset, blocks}` per confirmation target and map the
 * `{asset, sat_per_vb}` responses into the `{fast, normal, slow}` shape callers
 * expect.
 *
 * This test drives the REAL Send wizard for BTC from Home → Asset → Address →
 * Compose and proves the fee tiers now resolve (a rate renders, the button is
 * not stuck disabled on a null fee) and the flow reaches the read-only Review
 * step. We STOP at Review and never click `send-review-submit`, so nothing is
 * broadcast.
 *
 * Determinism: the fee route is STUBBED with the NAMESPACED response shape
 * (`{asset, sat_per_vb}`, one rate per `blocks` target) so the outcome does not
 * hinge on live Electrum. This is exactly the shape the regression fix translates,
 * so stubbing it still exercises the real per-dialect mapping + the Compose fee
 * picker. The wallet's own BTC balance is NOT stubbed — it comes from the funded
 * alice wallet via the backend — because Compose gates Continue on amount + fee
 * not exceeding session balance.
 *
 * Preconditions mirror send-compose-xmr.spec.ts:
 *   - extension built with VITE_SMIRK_API_STYLE=namespaced (dist already is).
 *   - seed env sourced (SMOKE_ALICE_MNEMONIC).
 *
 * UI map (verified against packages/ui/src/components/SendWizard.tsx):
 *   Home action bar        → `home-action-send`
 *   Wizard step 0 (asset)  → `send-asset-btc`
 *   Wizard step 1 (address)→ `send-address-input` + `send-address-continue`
 *   Wizard step 2 (compose)→ `send-fee-tier-{fast,normal,slow}` + `send-amount-input`
 *                            + `send-compose-continue`
 *   Wizard step 3 (review) → `send-review-submit` (asserted, NOT clicked)
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

// A real, checksum-valid mainnet BTC bech32 (P2WPKH) address (the BIP173
// reference address). It only needs to pass the client-side `isValidBtcAddress`
// decode on the Address step — nothing is ever sent to it.
const BTC_RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('Send → BTC → fee tiers resolve (namespaced) → reach Review (no broadcast)', async ({
  context,
  extensionId,
  footage,
}) => {
  // --- Stub the fee route with the NAMESPACED shape (context-level so it
  //     covers whichever page issues the call). smirk-backend-core answers
  //     POST {asset, blocks} -> {asset, sat_per_vb}, one rate per confirmation
  //     target; the client fires blocks 1/3/6 for fast/normal/slow. We vary the
  //     rate by target so the mapping produces distinct, sane tiers. ---
  await context.route('**/wallet/utxo/fee', async (route) => {
    const body = route.request().postDataJSON() as
      | { asset?: string; blocks?: number }
      | null;
    const blocks = body?.blocks ?? 3;
    // Faster confirmation target => higher sat/vB. All well above the relay floor.
    const satPerVb = blocks <= 1 ? 12 : blocks <= 3 ? 8 : 4;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ asset: body?.asset ?? 'btc', sat_per_vb: satPerVb }),
    });
  });

  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/fee|auth|bootstrap|error|fail|401/i.test(t)) {
      console.log('CONSOLE', m.type(), t.slice(0, 180));
    }
  });

  // --- Onboarding: import alice (returning user → no PoW, no gate). Returns
  //     once authenticated (a real backend balance renders on Home). ---
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  footage.mark('wallet-ready', 'unlocked wallet, before the flow under test');

  await expect(page.getByTestId('onboarding-import-btn')).toHaveCount(0);
  await expect(page.getByTestId('home-action-send')).toBeVisible({ timeout: 40_000 });

  // --- Send wizard: Home → BTC → Address → Compose ----------------------
  await page.getByTestId('home-action-send').click();

  // Step 0 — pick BTC.
  const btcPick = page.getByTestId('send-asset-btc');
  await expect(btcPick).toBeVisible({ timeout: 15_000 });
  await btcPick.click();

  // Step 1 — recipient address.
  const addr = page.getByTestId('send-address-input');
  await expect(addr).toBeVisible();
  await addr.fill(BTC_RECIPIENT);
  const addrContinue = page.getByTestId('send-address-continue');
  await expect(addrContinue).toBeEnabled();
  await addrContinue.click();

  // Step 2 — Compose. THE REGRESSION ASSERTION: the fee tiers populate. Before
  // the fix the picker was stuck on "Loading fee rates…" / a fee-estimate error
  // and every tier row was disabled with a "—" rate. Now `send-fee-tier-normal`
  // renders a usable "N.N sat/vB · …" rate and is enabled.
  const normalTier = page.getByTestId('send-fee-tier-normal');
  await expect(normalTier).toBeVisible({ timeout: 15_000 });
  await expect(normalTier).toBeEnabled();
  await expect(normalTier).toContainText(/sat\/vB/i);
  // Fee-estimate failure copy must NOT be present (that was the broken state).
  await expect(page.locator('#root')).not.toContainText(/Fee estimate failed/i);

  // Size a positive amount below balance so Continue is gated only on the fee
  // (which now resolves), not on funds. Read the "Balance: <n> BTC" line the
  // Compose screen renders and send a small fraction; fall back to a tiny fixed
  // amount if it can't be parsed.
  await expect(page.locator('#root')).toContainText(/Balance:\s*[\d.]+\s*BTC/i, {
    timeout: 15_000,
  });
  const composeText = (await page.locator('#root').innerText()).replace(/\s+/g, ' ');
  const balMatch = /Balance:\s*([\d.]+)\s*BTC/i.exec(composeText);
  const balance = balMatch ? parseFloat(balMatch[1]!) : NaN;
  const amountBtc =
    Number.isFinite(balance) && balance > 0 ? (balance / 2).toFixed(8) : '0.0001';
  console.log('COMPOSE balance=', balMatch?.[1] ?? '(unparsed)', 'amount=', amountBtc);

  await page.getByTestId('send-amount-input').fill(amountBtc);

  // "Continue to review" must become ENABLED — the whole point of the fix. A
  // null fee (the bug) would keep `canContinue` false and lock this button.
  const composeContinue = page.getByTestId('send-compose-continue');
  await expect(composeContinue).toContainText(/Continue to review/i);
  await expect(composeContinue).toBeEnabled({ timeout: 15_000 });
  await composeContinue.click();

  // --- Step 3 — Review reached (read-only). Assert, do NOT submit. -------
  const reviewSubmit = page.getByTestId('send-review-submit');
  await expect(reviewSubmit).toBeVisible({ timeout: 15_000 });

  const root = page.locator('#root');
  await expect(root).toContainText('Review');
  // The regression signal: a real sat/vB fee rate resolved and is shown on Review
  // (the estimateFee dialect fix). The Review label is "Fee tier <name> (N sat/vB)".
  await expect(root).toContainText(/sat\/vB/i);
  await expect(reviewSubmit).toContainText(/Send/i);
  footage.mark('btc-fee-review', 'BTC fee tier resolved, Review step reached');

  // Guard: we must NOT have advanced past Review (nothing broadcast).
  await expect(page.getByTestId('send-done-txid')).toHaveCount(0);
});
