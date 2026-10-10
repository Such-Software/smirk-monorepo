/**
 * The live lane for sends, receives and history (area B). SPENDS REAL FUNDS.
 *
 * Separate from playwright.config.ts on purpose: the ordinary suite stays
 * fundless and capture-closed. This lane keeps Playwright trace, screenshot
 * and video OFF (they cannot be guarded frame by frame) and keeps the private
 * reporter and the skip guard; footage, when asked for, comes from the
 * fixture's guarded recorder (fixtures/B-send-receive-history-footage.ts).
 *
 * Run (from packages/e2e), every gate explicit, no phrase on any command line:
 *
 *   E2E_LIVE=1 E2E_LIVE_MONEY=1 ALLOW_PROD_WRITES=1 FOOTAGE=guarded \
 *   BACKEND_URL=https://api.smirk.cash/api/v1 \
 *   E2E_LIVE_EXTENSION_ZIP=~/Build/smirk-release/v0.3.1-run-11204/staged/smirk-wallet-chrome-v0.3.1.zip \
 *   E2E_LIVE_EXTENSION_SHA256=e64fb7aca1012b10cc078fcdc272685e0966e356297a5c8aa59485aa08485776 \
 *   E2E_LIVE_WALLET_FILE=<main checkout>/packages/smoke-tests/secrets/smoke-mnemonics.env \
 *   E2E_LIVE_RUN_LABEL=run-11204 \
 *   npx playwright test -c B-send-receive-history.live.config.ts
 *
 * The wallet file is read by path, in process, one variable at a time; never
 * source it. Projects run in order: sends and receives, then history detail
 * (which reads the run's ledger). Run one with --project. The history project
 * can be re-run later against the same E2E_LIVE_RUN_LABEL.
 *
 * Restore budget: each worker imports all three wallets, and the backend
 * allows 30 restore attempts per IP per hour (and 3 failed ones per wallet).
 * A full run starts two workers (six imports); a failed test restarts its
 * worker and imports again. Do not run other live lanes from the same IP at
 * the same time, and use --max-failures=1 when iterating.
 *
 * Afterwards, encode the footage (1.0x, no trimming, holds verified):
 *   node scripts/B-send-receive-history-footage.mjs --run ~/Build/smirk-e2e/v0.3.1-run-11204
 */

import { defineConfig } from '@playwright/test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PRIVATE_USE, assertPrivateCapture } from './capture-policy.mjs';

assertPrivateCapture();
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
// Sixteen tests in this lane: eleven send/receive, five history.
process.env.E2E_MIN_EXECUTED ??= '16';

/**
 * Verify the staged store zip and unpack it once, so global setup checks the
 * exact bytes under test. A hash mismatch refuses before anything launches.
 */
const zip = process.env.E2E_LIVE_EXTENSION_ZIP;
if (zip && !process.env.EXTENSION_DIST) {
  const expected = (process.env.E2E_LIVE_EXTENSION_SHA256 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('E2E_LIVE_EXTENSION_ZIP needs E2E_LIVE_EXTENSION_SHA256');
  const bytes = readFileSync(resolve(zip));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error('the extension zip does not match E2E_LIVE_EXTENSION_SHA256; refusing to test other bytes');
  }
  // Unpacked fresh every run, from the bytes just verified.
  const dir = join(homedir(), 'Build', 'smirk-e2e', '.scratch', `B-extension-${expected.slice(0, 16)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const unpacked = spawnSync('unzip', ['-q', resolve(zip), '-d', dir], { stdio: 'ignore' });
  if (unpacked.status !== 0 || !existsSync(join(dir, 'manifest.json'))) throw new Error('could not unpack the extension zip');
  process.env.EXTENSION_DIST = dir;
}

export default defineConfig({
  testDir: './tests/live',
  timeout: 3 * 60 * 60_000,
  globalTimeout: 12 * 60 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './global-setup.ts',
  reporter: [['./private-reporter.ts'], ['./skip-guard-reporter.ts']],
  quiet: true,
  preserveOutput: 'never',
  use: PRIVATE_USE,
  projects: [
    { name: 'B-send-receive', testMatch: /b-send-receive\.live\.spec\.ts$/ },
    { name: 'B-history-detail', testMatch: /b-history-detail\.live\.spec\.ts$/ },
  ],
});
