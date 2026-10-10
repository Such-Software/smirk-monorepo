import { defineConfig } from '@playwright/test';
import { PRIVATE_USE, assertPrivateCapture } from './capture-policy.mjs';

/**
 * The G-premium live lane: tests/live/g-premium.live.spec.ts against a real
 * backend with the owner-approved demo wallets. The default config ignores
 * tests/live, so this config is the only way the spec runs. The spec header
 * lists every gate; fixtures/G-premium-config.ts refuses a bad combination
 * before any wallet work.
 *
 * Playwright's own capture stays off (PRIVATE_USE), the private reporter and
 * the skip guard stay, and global-setup proves the unpacked release under
 * test (EXTENSION_DIST) targets BACKEND_URL. Footage comes only from the
 * guarded recorder (fixtures/G-premium-footage.ts).
 *
 *   E2E_LIVE=1 ALLOW_PROD_WRITES=1 FOOTAGE=guarded \
 *   BACKEND_URL=https://api.smirk.cash/api/v1 EXTENSION_DIST=<unpacked staged chrome zip> \
 *   LIVE_WALLET_FILE=<owner-only custody file> \
 *   [E2E_LIVE_MONEY=1 E2E_PREMIUM_PURCHASE=1 G_PREMIUM_CHECKOUT_HOST=<owner BTCPay host>] \
 *   npx playwright test -c G-premium.live.config.ts
 *
 * Every declared test must run: three when browsing, four with the purchase.
 * A skip (premium already active, the invoice cap reached, too little LTC)
 * fails the run and names what it did not prove. One worker; the wallets are
 * worker-scoped and the tests are serial.
 */
assertPrivateCapture();
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
process.env.E2E_MIN_EXECUTED ??=
  process.env.E2E_LIVE_MONEY === '1' && process.env.E2E_PREMIUM_PURCHASE === '1' ? '4' : '3';

const hours = Number(process.env.E2E_GLOBAL_TIMEOUT_H ?? '8');

export default defineConfig({
  testDir: './tests/live',
  testMatch: /(^|[\\/])g-premium\.live\.spec\.ts$/,
  // The purchase test sets three hours itself; the others set less.
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
