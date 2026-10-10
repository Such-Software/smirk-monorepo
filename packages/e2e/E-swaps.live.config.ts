import { defineConfig } from '@playwright/test';
import { PRIVATE_USE, assertPrivateCapture } from './capture-policy.mjs';

/**
 * The E-swaps live lane: tests/live/e-swaps.live.spec.ts against a real
 * backend with the owner-approved demo wallets. Gates and paths are described
 * in fixtures/E-swaps-live.ts; the spec header has a full command.
 *
 * Playwright's own capture stays off (PRIVATE_USE), the private reporter and
 * skip guard stay, and global-setup still proves the extension under test
 * targets BACKEND_URL. Footage, when FOOTAGE=guarded, comes only from the
 * guarded recorder (fixtures/E-swaps-footage.ts).
 *
 * Confirmation waits make single tests long (up to a few hours) and the whole
 * run up to about twelve. One worker; the wallets are worker-scoped.
 */
assertPrivateCapture();
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
// Registers the live tests; the main suite leaves this unset.
process.env.E2E_LANE = 'live';
// The lane has nine tests; the skip guard's default floor is the main suite's.
process.env.E2E_MIN_EXECUTED ??= '9';
// One id for the whole run, inherited by every worker (a failed test restarts
// the worker), so a wallet that could not be imported is not retried.
process.env.E_SWAPS_RUN_ID ??= String(Date.now());

const hours = Number(process.env.E2E_GLOBAL_TIMEOUT_H ?? '12');

export default defineConfig({
  testDir: './tests/live',
  testMatch: /e-swaps\.live\.spec\.ts$/,
  timeout: 3 * 60 * 60_000,
  globalTimeout: hours * 60 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './global-setup.ts',
  reporter: [['./private-reporter.ts'], ['./skip-guard-reporter.ts']],
  quiet: true,
  preserveOutput: 'never',
  use: PRIVATE_USE,
});
