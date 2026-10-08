import { defineConfig, devices } from '@playwright/test';

/**
 * Popup layout specs. Unlike the main suite these need no backend, no built
 * extension and no wallet: they render the real AppShell, popup stylesheet and
 * themes in a plain page, which is what lets them run in Firefox as well as
 * Chromium.
 *
 * `firefox-rfp` mirrors LibreWolf's defaults (also the core of Mullvad Browser
 * and Tor Browser): resistFingerprinting with letterboxing (rounded window and
 * screen sizes, forced light color scheme, restricted fonts, coarse timers),
 * WebGL off and strict tracking protection.
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
    {
      name: 'firefox-rfp',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'privacy.resistFingerprinting': true,
            'privacy.resistFingerprinting.letterboxing': true,
            'webgl.disabled': true,
            'browser.contentblocking.category': 'strict',
            'privacy.trackingprotection.enabled': true,
            'privacy.trackingprotection.socialtracking.enabled': true,
          },
        },
      },
    },
  ],
});
