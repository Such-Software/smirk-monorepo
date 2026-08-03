import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';

/**
 * balance-freshness-cue: the escalating "are these balances live?" affordance
 * (packages/ui/src/components/FreshnessCue.tsx) escalates on SUSTAINED refresh
 * failure and clears once a refresh succeeds again.
 *
 * The cue is time-since-last-success based: a single blip stays quiet, refreshes
 * failing for >30s show an amber warning, >60s a clear red error. The component
 * self-ticks every FRESHNESS_TICK_MS (5s) so it escalates on its own between the
 * popup's 25s background refreshes.
 *
 * Flow:
 *   1. Install Playwright's clock BEFORE load, then onboard alice so the FIRST
 *      balance refresh SUCCEEDS (this establishes `lastSuccessAt` on Home).
 *   2. Make every balance endpoint FAIL (btc/ltc utxo balance, xmr/wow lws
 *      balance, grin scan) so each attempted asset errors and the completed
 *      refresh is flagged failed.
 *   3. Fast-forward the clock past 30s → assert `data-freshness="warn"`, then
 *      past 60s → assert `data-freshness="error"` + role="alert".
 *   4. Unblock the balance routes so one refresh succeeds → assert the cue clears
 *      (the element renders nothing at the 'fresh' level).
 *
 * page.clock drives both the popup's 25s background-refresh interval (to land a
 * FAILED attempt) and the cue's own 5s ticker (to trip the 30s/60s thresholds),
 * so no real waiting is needed. `runFor` advances the fake clock tick by tick so
 * intervals fire; the async refresh that each firing kicks off settles in real
 * time, which the auto-retrying `expect` assertions absorb.
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

// Every backend endpoint that a balance refresh attempts, across all asset
// families. Failing ALL of them makes `allAttemptedBalancesFailed` true, which is
// what flips `lastRefreshFailed` and starts the cue's time-based escalation.
const BALANCE_ROUTES = [
  '**/wallet/utxo/balance', // btc / ltc
  '**/wallet/lws/balance', // xmr / wow
  '**/wallet/grin/scan', // grin
];

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('freshness cue escalates warn → error on sustained refresh failure, then clears', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/freshness|balance|refresh|error|fail|401/i.test(t)) {
      console.log('CONSOLE', m.type(), t.slice(0, 160));
    }
  });

  // This test escalates over REAL time (the cue warns at 30s, errors at 60s of
  // sustained failure). We drive it with real timers rather than page.clock: the
  // fake clock does not reliably fire the extension popup's setInterval + settle
  // its async balance fetches, whereas real timers do. It costs wall-clock time,
  // so the per-test budget is raised well past the escalation thresholds.
  test.setTimeout(180_000);

  // --- 1. Onboard alice with balances SUCCEEDING (routes not yet failing), so
  //        Home renders a real balance and the cue's success anchor is set. ---
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  await expect(page.getByTestId('onboarding-import-btn')).toHaveCount(0);
  await expect(page.getByTestId('home-action-send')).toBeVisible({ timeout: 40_000 });

  // --- 2. Now make every balance refresh FAIL. A mutable flag lets us flip the
  //        same routes back to live at the end to prove the cue clears. ---
  let failBalances = true;
  for (const pattern of BALANCE_ROUTES) {
    await context.route(pattern, async (route) => {
      if (failBalances) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'freshness-cue e2e: forced balance failure' }),
        });
      } else {
        // Let the real backend answer so a genuine balance lands and the cue clears.
        await route.continue();
      }
    });
  }

  const cue = page.getByTestId('balance-freshness-cue');

  // --- 3. Trigger an immediate FAILED refresh (anchors lastRefreshFailed now,
  //        without waiting ~25s for the background loop), then let the cue's real
  //        5s ticker escalate over wall-clock time: warn at 30s since the last
  //        success, error at 60s. Timeouts are generous enough to absorb timer
  //        drift; the exact boundary logic is pinned by the FreshnessCue unit test.
  await page.getByRole('button', { name: /refresh/i }).click();
  await expect(cue).toHaveAttribute('data-freshness', 'warn', { timeout: 50_000 });
  await expect(cue).toHaveAttribute('data-freshness', 'error', { timeout: 60_000 });
  await expect(cue).toHaveAttribute('role', 'alert');

  // --- 4. Unblock the routes and trigger a DETERMINISTIC refresh → the cue clears.
  //        Use the accessible "Refresh balances" control rather than waiting on the
  //        25s background loop firing AND its async fetch settling under the fake
  //        clock (that timing is flaky). A successful refresh flips
  //        lastRefreshFailed to false, so the cue drops to 'fresh' and, since
  //        FreshnessCue renders null there, the element disappears. (The recovery
  //        state logic itself is covered exhaustively by the FreshnessCue unit test.)
  failBalances = false;
  await page.getByRole('button', { name: /refresh/i }).click();
  await expect(cue).toHaveCount(0, { timeout: 20_000 });
});
