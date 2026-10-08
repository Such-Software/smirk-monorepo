import { defineConfig, devices } from '@playwright/test';

/**
 * Popup layout specs. Unlike the main suite these need no backend, no built
 * extension and no wallet: they render the real AppShell and popup stylesheet
 * in a plain page, which is what lets them run in Firefox as well as Chromium.
 *
 * Run: npm run test:layout -w @smirk/e2e
 * Browsers: npx playwright install chromium firefox
 */
export default defineConfig({
  testDir: './layout',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  preserveOutput: 'never',
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
