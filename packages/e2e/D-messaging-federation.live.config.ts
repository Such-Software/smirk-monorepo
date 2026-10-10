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
 *   E2E_LIVE_LINK=1 ALLOW_PROD_WRITES=1 \
 *   BACKEND_URL=https://api.smirk.cash/api/v1 EXTENSION_DIST=<unpacked zip> \
 *   E2E_WALLET_FILE=<owner-only custody file> E2E_MIN_EXECUTED=1 \
 *   [FED_BACKEND_URL=<B> FED_BACKEND_APPROVED=1] \
 *   npx playwright test -c D-messaging-federation.live.config.ts
 *
 * Run it ALONE. Lanes B, C and E use alice, bob and carol too, and the
 * federation test compares carol's balances before and after her trip to
 * backend B exactly. (Relay checks look up this run's own gift wraps by id, so
 * they would survive concurrent traffic; the balance check would not.)
 *
 * Owner approvals this lane reads, each a durable production write and never
 * inferred: `E2E_LIVE_LINK=1` with `ALLOW_PROD_WRITES=1` links an unlinked demo
 * wallet's seed npub to its account (without it the DM tests fail, because the
 * operator relay refuses DMs to unlinked npubs); `E2E_LIVE_CAROL_HANDLE=<name>`
 * claims a handle for carol; `E2E_LIVE_FEED_POST=1` posts one public note;
 * `FED_BACKEND_APPROVED=1` registers carol on a shared backend B.
 *
 * Any skip fails the run (skip guard): a skipped scenario is not evidence. The
 * cross-server name@domain test skips until a backend B serves both a relay and
 * HTTPS NIP-05, so a green run needs that B or an owner decision on that skip.
 * That decision is `E2E_LIVE_ACK_GAPS=federation` (the same acknowledgement the
 * C-tips lane reads): the federation skips are then listed as chosen by the
 * operator, never counted as evidence, and every other skip still fails. The
 * findings file names what was not proven either way.
 *
 * Findings go to E2E_REPORTS_DIR when set (the v0.3.1 runner puts them beside
 * the area's footage), else ~/Build/smirk-e2e/v<version>-<label>/reports.
 */
assertPrivateCapture();
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

/** Skip reasons of the federation file and its cross-server test (fixtures/D-messaging-federation-live.ts, tests/live/d-federation.live.spec.ts). */
const FEDERATION_GAP_REASONS = [
  'federation: ',
  'cross-server delivery by name@domain cannot be exercised',
  'carol has no handle on backend B',
  'carol is not linked on backend B',
];
const ackGaps = (process.env.E2E_LIVE_ACK_GAPS ?? '').split(',').map((gap) => gap.trim());
const expectedReasonPrefixes = ackGaps.includes('federation') ? FEDERATION_GAP_REASONS : [];

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
  reporter: [['./private-reporter.ts'], ['./skip-guard-reporter.ts', { expectedReasonPrefixes }]],
  quiet: true,
  preserveOutput: 'never',
  // Capture stays off (PRIVATE_USE). Every action is bounded: a tap on a
  // control that never becomes actionable must fail the step, not sit until the
  // two-hour test budget runs out.
  use: { ...PRIVATE_USE, actionTimeout: 90_000, navigationTimeout: 90_000 },
});
