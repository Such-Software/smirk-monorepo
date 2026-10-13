/**
 * The live lane for sends, receives and history (area B). SPENDS REAL FUNDS.
 *
 * Separate from playwright.config.ts on purpose: the ordinary suite stays
 * fundless and capture-closed (it ignores tests/live). This lane keeps
 * Playwright trace, screenshot and video OFF (they cannot be guarded frame by
 * frame) and keeps the private reporter and the skip guard; footage, when
 * asked for, comes from the fixture's guarded recorder
 * (fixtures/B-send-receive-history-footage.ts).
 *
 * Run (from packages/e2e), every gate explicit, no phrase on any command line:
 *
 *   E2E_LIVE=1 E2E_LIVE_MONEY=1 ALLOW_PROD_WRITES=1 FOOTAGE=guarded \
 *   BACKEND_URL=https://api.smirk.cash/api/v1 \
 *   E2E_LIVE_EXTENSION_ZIP=~/Build/smirk-release/v<version>-run-<run>/staged/smirk-wallet-chrome-v<version>.zip \
 *   E2E_LIVE_EXTENSION_SHA256=<its SHA-256, fixtures/release-candidate.json> \
 *   E2E_LIVE_WALLET_FILE=<main checkout>/packages/smoke-tests/secrets/smoke-mnemonics.env \
 *   E2E_LIVE_RUN_LABEL=run-<run> \
 *   npx playwright test -c B-send-receive-history.live.config.ts
 *
 * The wallet file is read by path, in process, one variable at a time; never
 * source it.
 *
 * Cheap first: run `--grep funding` alone before the full run. It reads every
 * wallet's balance of every coin (about twenty minutes with the video holds)
 * and names any wallet that cannot fund its coin's ring, before any money
 * moves. The full run puts the same check right after the receive addresses.
 *
 * One project, one worker: every payment's history check runs in the test
 * (and the browser profiles) that made it, because the send record behind
 * the history sheet's recipient, fee and transaction key, and all Grin
 * history, live only in the profile that signed. Profiles are per run, so a
 * worker restarted after a failed test reopens them (unlock, no restore)
 * instead of importing again; the backend allows 30 restore attempts per IP
 * per hour and 3 failed ones per wallet. Profiles are deleted when the
 * invocation ends; E2E_LIVE_KEEP_PROFILES=1 keeps them for a later re-run
 * with the same E2E_LIVE_RUN_LABEL. Do not run other live lanes from the same
 * IP at the same time, and use --max-failures=1 when iterating.
 *
 * Duration: about eleven hours at average block times with the owner's holds
 * (6 s before every tap, 12 s on every settled screen, 25 s on every result),
 * longer when blocks are slow; BTC's three payments alone can take five hours
 * at one confirmation each in a slow hour. Hence the 24 h global timeout.
 *
 * The skip guard counts the tests this invocation selected: every selected
 * test must run, so `--grep` subsets work and a skip still fails the run.
 *
 * Afterwards, encode the footage (1.0x, no trimming, holds verified):
 *   node scripts/B-send-receive-history-footage.mjs --run ~/Build/smirk-e2e/v<version>-run-<run>
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
// Every test this invocation selects must run; a skip is a failure here.
process.env.E2E_MIN_EXECUTED ??= 'selected';

const HOUR = 60 * 60_000;

/**
 * Verify the staged store zip and unpack it once, so global setup checks the
 * exact bytes under test. A hash mismatch refuses before anything launches.
 * The unpacked path is named by the hash, so the extension keeps its id from
 * one worker (and one invocation) to the next.
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
  // Each test sets its own budget (BTC up to 8 h); this covers anything that does not.
  timeout: 2 * HOUR,
  globalTimeout: 24 * HOUR,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './global-setup.ts',
  globalTeardown: './fixtures/B-send-receive-history-teardown.ts',
  reporter: [['./private-reporter.ts'], ['./skip-guard-reporter.ts']],
  quiet: true,
  preserveOutput: 'never',
  use: PRIVATE_USE,
  projects: [{ name: 'B-live', testMatch: /b-send-receive\.live\.spec\.ts$/ }],
});
