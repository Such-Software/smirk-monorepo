import { defineConfig } from '@playwright/test';
import { PRIVATE_USE, assertPrivateCapture } from './capture-policy.mjs';

/**
 * The live lane: the release candidate's extension, the owner-approved demo
 * wallets (alice, bob, carol) and the production backend, recorded through
 * the guarded recorder (fixtures/guarded-footage.ts).
 *
 * Each gate is its own opt-in:
 *   E2E_LIVE=1           run this lane at all (preflight refuses otherwise)
 *   ALLOW_PROD_WRITES=1  scenarios that create users, claim handles, publish, or
 *                        ask the backend for a sign-in challenge
 *   E2E_LIVE_MONEY=1     scenarios that move funds (other areas)
 *   FOOTAGE=guarded      record; unset or "off" records nothing
 *
 * Owner decisions, closed unless set:
 *   E2E_ACCEPT_DIRTY_BUILD=1  accept a release candidate whose build stamp ends
 *                             in -dirty (built from a modified tree); listed
 *                             as not proven either way
 *
 * The demo wallets are compared with what they were before v0.3.1 (user ids,
 * receipts, a sent tip): fixtures/A-onboarding-identity-baseline.ts, or a JSON
 * file of the same shape in E2E_BASELINE_FILE. A wallet without a baseline
 * skips those scenarios with that reason, and the reporter lists it.
 *
 * Playwright's trace, screenshot and video stay off: they cannot be guarded
 * frame by frame. The private reporter stays, beside the lane's skip guard,
 * which also lists every claim a test ran without checking.
 *
 *   E2E_LIVE=1 FOOTAGE=guarded ALLOW_PROD_WRITES=1 \
 *   E2E_WALLET_FILE=<owner-only custody file> \
 *   npx playwright test -c packages/e2e/playwright.live.config.ts
 *
 * By default the preflight verifies and unpacks the staged Chrome zip of run
 * 11204 (E2E_EXTENSION_ZIP and E2E_EXTENSION_SHA256 override it).
 */
assertPrivateCapture();
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
// Live specs declare their tests only under this lane, so the default config,
// whose testDir contains tests/live, sees no live tests and no live skips.
process.env.SMIRK_E2E_LANE = 'live';
process.env.BACKEND_URL ??= 'https://api.smirk.cash/api/v1';

export default defineConfig({
  testDir: './tests/live',
  testMatch: /\.live\.spec\.ts$/,
  // Confirmation waits in the funds areas can take hours; the whole run about twelve.
  timeout: 3 * 60 * 60_000,
  globalTimeout: 12 * 60 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './fixtures/A-onboarding-identity-live-preflight.ts',
  reporter: [['./private-reporter.ts'], ['./fixtures/A-onboarding-identity-live-reporter.ts']],
  quiet: true,
  preserveOutput: 'never',
  // The runner's default for both is no limit, so one renamed element would
  // stall the run for the three-hour test timeout. The live profiles set the
  // same limits on themselves (fixtures/live-wallets.ts); long waits that are
  // expected (proof of work, confirmations) pass their own timeouts.
  use: { ...PRIVATE_USE, actionTimeout: 60_000, navigationTimeout: 120_000 },
});
