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
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: CAPTURE ? 'on' : 'only-on-failure',
    video: CAPTURE ? 'on' : 'retain-on-failure',
  },
});
