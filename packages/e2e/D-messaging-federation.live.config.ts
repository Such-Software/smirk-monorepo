import { defineConfig } from '@playwright/test';
import { PRIVATE_USE, assertPrivateCapture } from './capture-policy.mjs';

/**
 * Area D live lane (messaging and federation) for the release run.
 *
 * Same privacy contract as the wallet suite: Playwright trace, screenshot and
 * video stay OFF (they cannot be guarded per frame), the private reporter and
 * the skip guard are the only reporters, and global setup proves the unpacked
 * release bundle targets BACKEND_URL. Recording, when `FOOTAGE=guarded`, is the
 * guarded recorder in fixtures/D-messaging-federation-footage.ts.
 *
 * Paced for review: holds of 6, 12 and 25 seconds, so a test may take most of
 * an hour. One worker, worker-scoped wallets, no retries.
 *
 *   E2E_LIVE=1 E2E_LIVE_RELAY=1 FOOTAGE=guarded E2E_RUN_LABEL=run-11204 \
 *   BACKEND_URL=https://api.smirk.cash/api/v1 EXTENSION_DIST=<unpacked zip> \
 *   E2E_WALLET_FILE=<owner-only custody file> E2E_MIN_EXECUTED=1 \
 *   npx playwright test -c D-messaging-federation.live.config.ts
 */
assertPrivateCapture();
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

export default defineConfig({
  testDir: './tests/live',
  testMatch: /d-(messaging|federation)\.live\.spec\.ts$/,
  timeout: 2 * 60 * 60_000,
  globalTimeout: 12 * 60 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './global-setup.ts',
  // Removes this run's wallet profiles (kept across worker restarts).
  globalTeardown: './fixtures/D-messaging-federation-teardown.ts',
  reporter: [['./private-reporter.ts'], ['./skip-guard-reporter.ts']],
  quiet: true,
  preserveOutput: 'never',
  // Capture stays off (PRIVATE_USE). Every action is bounded: a tap on a
  // control that never becomes actionable must fail the step, not sit until the
  // two-hour test budget runs out.
  use: { ...PRIVATE_USE, actionTimeout: 90_000, navigationTimeout: 90_000 },
});
