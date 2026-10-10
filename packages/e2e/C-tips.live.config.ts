import { randomUUID } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import { PRIVATE_USE, assertPrivateCapture } from './capture-policy.mjs';

/**
 * The C-tips live lane: tests/live/c-targeted-tips and c-tips against a real
 * backend with the owner-approved demo wallets, recorded. The main suite
 * ignores tests/live, so a default fundless run never sees these specs.
 *
 * Global setup refuses unless every gate is open (fixtures/C-tips-live.ts),
 * verifies the release zip by SHA-256 and version, unpacks it into the run
 * state directory and points EXTENSION_DIST at it, checks ffmpeg, and refuses
 * to mix a new run into an earlier invocation's unsettled ledger. Global
 * teardown encodes the footage to video, checks every hold in the output,
 * and deletes the wallet profiles only once every tip of the run is settled.
 *
 *   E2E_LIVE=1 E2E_LIVE_MONEY=1 ALLOW_PROD_WRITES=1 FOOTAGE=guarded
 *   BACKEND_URL=https://api.smirk.cash/api/v1
 *   SMOKE_WALLET_FILE=<owner-only demo wallet file>
 *   E2E_RELEASE_ZIP     default ~/Build/smirk-release/v0.3.1-run-11204/staged/smirk-wallet-chrome-v0.3.1.zip
 *   E2E_RELEASE_SHA256  default the run-11204 Chrome zip (e64fb7ac...)
 *   E2E_RELEASE_VERSION default 0.3.1
 *   E2E_RUN_LABEL       default v0.3.1-run-11204 (names the run directory)
 *   E2E_CLAIM_BOB_HANDLE=<name>    let the lane claim a handle for bob if he has none
 *   E2E_FOREIGN_NIP05=name@domain  bob's address on a foreign NIP-05 domain
 *   FED_BACKEND_URL     a second, independent backend
 *   E2E_LIVE_ACK_GAPS=federation   acknowledge that neither of the two above exists
 *   E2E_LIVE_SKIP_DELIVERY_FAILURE=1  opt out of the blocked-delivery rehearsal
 *   E2E_LIVE_RESCUE=1   settle an earlier invocation's tips (with --grep "rescue|overview")
 *
 * Holds make every step slow (a still screen before and after each tap), and
 * confirmation waits dominate: budget most of a day. One worker; the wallets
 * are worker-scoped, and a failed test restarts the worker, which reopens the
 * same profiles.
 */
assertPrivateCapture();
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
// One id for this invocation, inherited by every worker: the ledger, the
// footage sessions and the video are grouped by it.
process.env.C_TIPS_INVOCATION ??= `i${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
// The lane's own floor: most tests must run. A rescue run runs only two.
process.env.E2E_MIN_EXECUTED ??= process.env.E2E_LIVE_RESCUE === '1' ? '1' : '40';

const hours = Number(process.env.E2E_GLOBAL_TIMEOUT_H ?? '20');

export default defineConfig({
  testDir: './tests/live',
  testMatch: /c-(targeted-)?tips\.live\.spec\.ts$/,
  timeout: 4 * 60 * 60_000,
  globalTimeout: hours * 60 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './fixtures/C-tips-global-setup.ts',
  globalTeardown: './fixtures/C-tips-global-teardown.ts',
  // Skips the operator chose (an optional rehearsal, an acknowledged gap, a
  // rescue run) are listed but expected; any other skip fails the run.
  reporter: [
    ['./private-reporter.ts'],
    ['./skip-guard-reporter.ts', { expectedReasonPrefixes: ['optional:', 'acknowledged gap:', 'rescue run:'] }],
  ],
  quiet: true,
  preserveOutput: 'never',
  use: PRIVATE_USE,
});
