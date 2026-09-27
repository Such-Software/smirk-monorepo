import { defineConfig } from '@playwright/test';
import { PRIVATE_USE, assertPrivateCapture } from './capture-policy.mjs';

/**
 * The MV3 extension runs in a persistent Chromium context with a background
 * service worker, so scenarios are stateful and must not run in parallel within
 * a project. One worker, no retries by default (a flaky E2E is a bug to fix, not
 * paper over). `BACKEND_URL` targets the instance under test; default is the
 * local smirk-backend-core.
 */
assertPrivateCapture();
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Fails fast when the built extension targets a different backend than the
  // specs do, which otherwise fails later in ways that look like app bugs.
  globalSetup: './global-setup.ts',
  // `skip-guard` fails the run when specs skip without an expected reason, or
  // when overall coverage collapses. Without it the suite can report
  // "2 passed, 23 skipped" and exit 0. A skip is not a pass.
  // Reporter overrides are refused by preflight: generic reporters can retain
  // input values, assertion diffs, browser logs and page snapshots.
  reporter: [['./private-reporter.ts'], ['./skip-guard-reporter.ts']],
  quiet: true,
  preserveOutput: 'never',
  use: PRIVATE_USE,
});
