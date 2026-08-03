import { defineConfig } from '@playwright/test';

/**
 * The MV3 extension runs in a persistent Chromium context with a background
 * service worker, so scenarios are stateful and must not run in parallel within
 * a project. One worker, no retries by default (a flaky E2E is a bug to fix, not
 * paper over). `BACKEND_URL` targets the instance under test — default is the
 * local smirk-backend-core.
 */
// CAPTURE_VIDEO=1|on records EVERY test's video + screenshots (not just failures) so an
// e2e run doubles as demo-video capture. The extension's own persistent context records
// the popup / approval window at a mobile-portrait size (see fixtures/extension.ts);
// this covers any Playwright-managed contexts too. Default stays lean: on-failure only.
const CAPTURE = ['1', 'on', 'true', 'yes'].includes(
  (process.env.CAPTURE_VIDEO ?? '').toLowerCase(),
);

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
  // WARNING: `--reporter=<x>` on the CLI REPLACES this whole list, which
  // silently drops the skip guard. A local `npx playwright test --reporter=line`
  // therefore reports "28 passed, 8 skipped" and exits 0 even when specs that
  // should have run were quietly excused. That happened during development of
  // this very suite, so use `npm test` (no --reporter) or, if you must override,
  // keep the guard: `--reporter=list,./skip-guard-reporter.ts` (which is what
  // the CI workflows do).
  reporter: [['list'], ['html', { open: 'never' }], ['./skip-guard-reporter.ts']],
  use: {
    trace: 'retain-on-failure',
    screenshot: CAPTURE ? 'on' : 'only-on-failure',
    video: CAPTURE ? 'on' : 'retain-on-failure',
  },
});
