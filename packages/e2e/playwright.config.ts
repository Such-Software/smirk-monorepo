import { defineConfig } from '@playwright/test';

/**
 * The MV3 extension runs in a persistent Chromium context with a background
 * service worker, so scenarios are stateful and must not run in parallel within
 * a project. One worker, no retries by default (a flaky E2E is a bug to fix, not
 * paper over). `BACKEND_URL` targets the instance under test — default is the
 * local smirk-backend-core.
 */
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
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
