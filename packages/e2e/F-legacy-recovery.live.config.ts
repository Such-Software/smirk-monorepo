import { defineConfig } from '@playwright/test';
import { PRIVATE_USE, assertPrivateCapture } from './capture-policy.mjs';
import {
  ACTION_TIMEOUT_MS,
  LANE_ID,
  expectedExecuted,
  laneGates,
  lanePreflight,
  moveScenarios,
} from './fixtures/F-legacy-recovery-lane.mjs';

/**
 * The F-legacy-recovery live lane: tests/live/f-legacy-recovery.live.spec.ts
 * against a real backend with the owner-approved demo wallets. The spec header
 * has the full command; gates are in fixtures/F-legacy-recovery-lane.mjs.
 *
 * This config is the only way the spec declares tests (it sets E2E_LANE), so the
 * lane never shares an invocation, or a wallet profile, with another live lane.
 * Every cheap refusal runs here, before global setup or a browser: E2E_LIVE,
 * phrases in the environment, the custody file, FOOTAGE, the move amounts, and
 * EXTENSION_DIST against the pinned release zip. A refusal names its cause.
 *
 * Playwright's own capture stays off (PRIVATE_USE), the private reporter and
 * skip guard stay, and global-setup still proves the extension under test
 * targets BACKEND_URL. Footage comes only from the guarded recorder.
 *
 * The skip guard's floor is the number of tests that cannot skip with an
 * expected reason once their gates are open; the guard excuses only "opt-in: "
 * and "no fixture: " skips for this spec. Confirmation and scan waits make
 * single tests long (F4 up to eight hours). One worker; wallets are worker-scoped.
 */
assertPrivateCapture();
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
process.env.E2E_LANE = LANE_ID;
lanePreflight();
process.env.E2E_MIN_EXECUTED ??= String(expectedExecuted(laneGates(), moveScenarios().length));

const hours = Number(process.env.E2E_GLOBAL_TIMEOUT_H ?? '24');

export default defineConfig({
  testDir: './tests/live',
  testMatch: /f-legacy-recovery\.live\.spec\.ts$/,
  timeout: 60 * 60_000,
  globalTimeout: hours * 60 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './global-setup.ts',
  reporter: [['./private-reporter.ts'], ['./skip-guard-reporter.ts']],
  quiet: true,
  preserveOutput: 'never',
  use: { ...PRIVATE_USE, actionTimeout: ACTION_TIMEOUT_MS, navigationTimeout: ACTION_TIMEOUT_MS },
});
