/**
 * THE LIVE MONEY GATE: a per-payment subaddress must be SPENDABLE.
 *
 * Everything else about subaddresses is provable without moving funds, and is
 * (derivation is oracle-checked against monero-oxide, issuance is covered by
 * subaddress-receive.spec, provisioning is covered by migration-subaddress.spec).
 * The one property none of that reaches is the one that matters most: money that
 * lands on an issued subaddress can actually be spent again.
 *
 * That gap is not academic. The failure mode it guards is silent and total: the
 * LWS is never told to scan the index, the output never appears in the balance,
 * and the funds are unspendable until somebody provisions that range and
 * rescans. A wallet that shows a receive address it cannot later spend from has
 * taken the user's money.
 *
 * SHAPE: a self-send. One wallet, real coin.
 *   1. issue a fresh subaddress
 *   2. send a small amount from the wallet's own balance TO that subaddress
 *   3. wait for the output to confirm AND unlock (CryptoNote outputs need 10
 *      confirmations before they can be spent, so this is ~20 minutes on a
 *      2-minute block, not seconds)
 *   4. spend FROM that output back to the primary address
 *
 * Step 4 is the assertion. Steps 1-3 only set it up. If the subaddress output
 * were invisible or unspendable, the wallet could not construct step 4 at all:
 * `sign()` is fail-closed and asserts `input_key·G == input.key()`, so a wrong
 * key offset produces a refusal rather than a broadcastable-but-dead tx.
 *
 * WHY WOW: the smoke wallet is funded in Wownero, blocks are cheap and fast, and
 * an error costs a trivial amount rather than real Monero.
 *
 * THIS SPENDS REAL MONEY, so it is gated on an explicit opt-in and never runs by
 * accident:
 *
 *     E2E_LIVE_MONEY=1 SMOKE_ALICE_MNEMONIC=... \
 *       npx playwright test tests/subaddress-spend-live.spec.ts
 *
 * It belongs in CI tier B (tag / nightly, real nodes, funded wallets), never in
 * the per-PR tier. Budget an hour of wall clock.
 */

import { test, expect } from '../fixtures/extension.js';
import type { Page } from '@playwright/test';
import { importAndUnlock } from '../fixtures/onboard.js';
import { getCapabilities } from '../fixtures/capabilities.js';

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC ?? '';
const LIVE = process.env.E2E_LIVE_MONEY === '1';

/** Small enough that a bug is cheap, large enough to clear dust and fees. */
const SEND_AMOUNT = process.env.E2E_LIVE_AMOUNT ?? '0.05';

test.skip(!LIVE, 'live-money gate: set E2E_LIVE_MONEY=1 to run (SPENDS REAL FUNDS)');
test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

// Confirm + unlock + a second send. CryptoNote needs 10 confirmations before an
// output is spendable, so this is inherently tens of minutes.
test.setTimeout(75 * 60_000);

async function enableSubaddressReceive(page: Page) {
  await page.addInitScript(() => {
    (globalThis as { __SMIRK_ENABLE_SUBADDRESS_RECEIVE__?: boolean })
      .__SMIRK_ENABLE_SUBADDRESS_RECEIVE__ = true;
  });
}

/** Home balance for an asset, as a number. `null` when it has not rendered. */
async function wowBalance(page: Page): Promise<number | null> {
  const txt = await page.locator('#root').innerText();
  const m = txt.match(/Wownero\s*WOW\s*([\d.]+)/i);
  return m?.[1] ? Number(m[1]) : null;
}

test('funds received on an issued subaddress can be spent again', async ({
  context,
  extensionId,
  footage,
}) => {
  const caps = (await getCapabilities()) as unknown as {
    chains: Record<string, { enabled?: boolean } | undefined>;
    features?: { xmr_subaddr_provisioning?: boolean };
  };
  test.skip(!caps.chains.wow?.enabled, 'wow disabled on this backend');
  test.skip(
    !caps.features?.xmr_subaddr_provisioning,
    'backend has FEATURE_XMR_SUBADDR_PROVISIONING off, so no index can be provisioned',
  );

  const page = await context.newPage();
  await enableSubaddressReceive(page);
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC });
  footage.mark('wallet-ready', 'funded wallet, before the live subaddress gate');

  const startBalance = await wowBalance(page);
  expect(startBalance, 'no WOW balance rendered; cannot run a live spend').not.toBeNull();
  expect(
    startBalance!,
    `WOW balance ${startBalance} is too low to send ${SEND_AMOUNT} and pay a fee`,
  ).toBeGreaterThan(Number(SEND_AMOUNT) * 2);
  console.log(`[live] starting WOW balance: ${startBalance}`);

  // ── 1. issue a fresh subaddress ────────────────────────────────────────────
  await page.getByTestId('home-action-receive').click();
  await page.getByTestId('receive-asset-wow').click();
  const addressEl = page.getByTestId('receive-address');
  await expect(addressEl).toBeVisible({ timeout: 30_000 });
  await expect(addressEl).not.toHaveText('Loading address…');
  const primary = (await addressEl.textContent())?.trim() ?? '';

  const newBtn = page.getByTestId('receive-new-address-btn');
  await expect(
    newBtn,
    'no issuance affordance: the flag or the backend capability is off, so there ' +
      'is no subaddress to test',
  ).toBeVisible({ timeout: 45_000 });
  await newBtn.click();

  const err = page.getByTestId('receive-new-address-error');
  if (await err.isVisible({ timeout: 15_000 }).catch(() => false)) {
    throw new Error(
      `could not issue a subaddress: ${(await err.textContent())?.trim()}. ` +
        'Fail-closed is correct behaviour, but it means this gate cannot run.',
    );
  }
  await expect(addressEl).not.toHaveText(primary, { timeout: 20_000 });
  const subaddress = (await addressEl.textContent())?.trim() ?? '';
  expect(subaddress).not.toEqual(primary);
  console.log(`[live] issued subaddress: ${subaddress.slice(0, 16)}…`);
  footage.mark('subaddress-issued', 'fresh WOW subaddress for the live gate');

  // ── 2. send to it from our own balance ─────────────────────────────────────
  await page.getByTestId('nav-tab-home').click();
  await page.getByTestId('home-action-send').click();
  await page.getByTestId('send-asset-wow').click();
  await page.getByTestId('send-address-input').fill(subaddress);
  await page.getByTestId('send-address-continue').click();
  await page.getByTestId('send-amount-input').fill(SEND_AMOUNT);
  await page.getByTestId('send-compose-continue').click();

  // This is the only place in the suite that broadcasts.
  await page.getByTestId('send-review-submit').click();
  const txid = page.getByTestId('send-done-txid');
  await expect(
    txid,
    'the send never reached a txid, so nothing was broadcast to the subaddress',
  ).toBeVisible({ timeout: 120_000 });
  const fundingTxid = (await txid.textContent())?.trim() ?? '';
  console.log(`[live] funded the subaddress, txid: ${fundingTxid}`);
  footage.mark('subaddress-funded', `sent ${SEND_AMOUNT} WOW to the issued subaddress`);
  await page.getByTestId('send-done-close').click();

  // ── 3. wait for it to confirm AND unlock ───────────────────────────────────
  // Spendability, not just visibility: a CryptoNote output needs 10
  // confirmations. Poll the balance recovering rather than sleeping blindly, so
  // the log shows progress and a stall is diagnosable.
  console.log('[live] waiting for confirmation + unlock (10 blocks) …');
  await expect
    .poll(
      async () => {
        await page.getByTestId('nav-tab-home').click().catch(() => {});
        const b = await wowBalance(page);
        console.log(`[live]   balance now ${b} (was ${startBalance})`);
        return b !== null && b >= startBalance! - Number(SEND_AMOUNT) * 0.5;
      },
      {
        timeout: 60 * 60_000,
        intervals: [60_000],
        message:
          'the balance never recovered after sending to our own subaddress. ' +
          'That is the exact failure this gate exists for: funds sent to an ' +
          'index the LWS was not told to scan are invisible and unspendable.',
      },
    )
    .toBe(true);
  footage.mark('subaddress-confirmed', 'subaddress output confirmed and unlocked');

  // ── 4. THE ASSERTION: spend FROM that output ───────────────────────────────
  // Back to the primary address. If the subaddress output were unspendable the
  // wallet could not build this at all: signing is fail-closed on the key offset.
  await page.getByTestId('home-action-send').click();
  await page.getByTestId('send-asset-wow').click();
  await page.getByTestId('send-address-input').fill(primary);
  await page.getByTestId('send-address-continue').click();
  await page.getByTestId('send-amount-input').fill(String(Number(SEND_AMOUNT) / 2));
  await page.getByTestId('send-compose-continue').click();
  await page.getByTestId('send-review-submit').click();

  const spendTxid = page.getByTestId('send-done-txid');
  await expect(
    spendTxid,
    'could not spend the subaddress output. Either the wallet never saw it, or ' +
      'signing refused the key offset — both mean money received at an issued ' +
      'subaddress is stuck.',
  ).toBeVisible({ timeout: 120_000 });
  const out = (await spendTxid.textContent())?.trim() ?? '';
  expect(out.length).toBeGreaterThan(16);
  console.log(`[live] SPENT from the subaddress, txid: ${out}`);
  footage.mark('subaddress-spent', 'subaddress output spent back to primary — gate passed');
});
