/**
 * The E-swaps live lane: gates, wallets, footage and evidence for
 * tests/live/e-swaps.live.spec.ts.
 *
 * Every gate is its own explicit opt-in, and none is inferred:
 *
 *   E2E_LANE=live        set by E-swaps.live.config.ts; the main suite never
 *                        registers these tests.
 *   E2E_LIVE=1           drive the real wallet against the configured backend.
 *   E2E_LIVE_MONEY=1     the tests that broadcast real transactions.
 *   ALLOW_PROD_WRITES=1  required as well when the backend is shared or
 *                        production (fixtures/extension.ts isSharedBackend).
 *   FOOTAGE=guarded      record guarded frames and enforce the dead-air holds.
 *                        Unset records nothing and skips the holds.
 *
 * Paths: EXTENSION_DIST (the unpacked release build under test), EXTENSION_ZIP
 * (the release zip it was unpacked from; required for money tests and for a
 * recorded run, see E-swaps-build.mjs), E2E_EXPECT_ZIP_SHA256 (optional, the
 * zip's published hash), and E2E_WALLET_FILE (the custody file; required in a
 * worktree, which has none).
 *
 * Wallets: E_SWAPS_WALLETS (default alice,bob,carol) lists the demo wallets a
 * test may use, in order. Tests that need no funds use the first; a test that
 * spends uses the first whose confirmed balance covers it, read on screen.
 *
 * Output, all 0700/0600: one directory per run,
 * E2E_FOOTAGE_DIR (default ~/Build/smirk-e2e/<E2E_RUN_LABEL>/footage)
 * /E-swaps/run-<E_SWAPS_RUN_ID>/, holding evidence.json (the build proof and
 * the run's public results) and one directory per wallet session (frames/ and
 * timeline.json). A later run never reads or adds to an earlier run's files.
 * The in-flight ledger (E-swaps-ledger.mjs) lives outside the runs, at
 * E_SWAPS_LEDGER (default ~/Build/smirk-e2e/E-swaps-inflight.json).
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from './private-test.js';
import { BACKEND_URL, DEFAULT_BACKEND_URL, isSharedBackend } from './extension.js';
import { proveBuild, type BuildProof } from './E-swaps-build.mjs';
import { InflightLedger } from './E-swaps-ledger.mjs';
import { LiveWallet, WALLET_NAMES, type WalletName } from './E-swaps-wallets.js';
import { RC } from './release-candidate.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export type FootageMode = 'guarded' | 'off';

export interface LaneGates {
  registered: boolean;
  live: boolean;
  money: boolean;
  prodWrites: boolean;
  footage: FootageMode;
}

export function laneGates(env: NodeJS.ProcessEnv = process.env): LaneGates {
  const footage = (env.FOOTAGE ?? '').trim();
  if (footage !== '' && footage !== 'guarded') {
    throw new Error('FOOTAGE accepts only "guarded" (or unset). Playwright capture stays off in every lane.');
  }
  return {
    registered: env.E2E_LANE === 'live',
    live: env.E2E_LIVE === '1',
    money: env.E2E_LIVE_MONEY === '1',
    prodWrites: !isSharedBackend(env.BACKEND_URL ?? DEFAULT_BACKEND_URL) || env.ALLOW_PROD_WRITES === '1',
    footage: footage === 'guarded' ? 'guarded' : 'off',
  };
}

/** Why a live test must not run, or null. Static reasons only. */
export function liveRefusal(gates: LaneGates, needsMoney: boolean, build: BuildProof | null = null): string | null {
  if (!gates.live) return 'live lane: set E2E_LIVE=1 to drive the real wallet against the configured backend';
  if ((needsMoney || gates.footage === 'guarded') && !build?.zip) {
    return 'release evidence: set EXTENSION_ZIP to the release zip EXTENSION_DIST was unpacked from, so the run proves which build it drove';
  }
  if (!needsMoney) return null;
  if (!gates.money) return 'live money: set E2E_LIVE_MONEY=1 (this test broadcasts real transactions from a demo wallet)';
  if (!gates.prodWrites) return 'shared backend: set ALLOW_PROD_WRITES=1 as well to broadcast against it';
  return null;
}

/** The run id the lane config sets once for every worker of a run. */
export function runId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env.E_SWAPS_RUN_ID ?? '';
  if (!/^\d{6,}$/.test(id)) throw new Error('E_SWAPS_RUN_ID is unset or malformed; run the lane through E-swaps.live.config.ts');
  return id;
}

/** The demo wallets a test may use, in order. */
export function walletCandidates(env: NodeJS.ProcessEnv = process.env): WalletName[] {
  const names = (env.E_SWAPS_WALLETS ?? WALLET_NAMES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of names) if (!(WALLET_NAMES as readonly string[]).includes(n)) throw new Error('E_SWAPS_WALLETS names only alice, bob and carol');
  if (names.length === 0) throw new Error('E_SWAPS_WALLETS names no wallet');
  return [...new Set(names)] as WalletName[];
}

type EvidenceValue = string | number | boolean;

/**
 * Public results of one run (txids, states, amounts, the build proof). Never
 * secrets. A worker restarted inside the same run keeps what the earlier
 * worker wrote; a file from any other run is never read.
 */
export class Evidence {
  private readonly data: Record<string, Record<string, EvidenceValue>> = {};
  private header: Record<string, unknown>;

  constructor(private readonly file: string, run: string, private readonly isSecret: (value: string) => boolean) {
    this.header = { area: 'E-swaps', runId: run, backend: BACKEND_URL };
    if (existsSync(file)) {
      const previous = JSON.parse(readFileSync(file, 'utf8')) as { runId?: string; results?: Evidence['data'] };
      if (previous.runId !== run) throw new Error('an evidence file from another run is in this run directory');
      Object.assign(this.data, previous.results ?? {});
    }
  }

  /** Run-level facts (the build proof, the test source). Public only. */
  describe(key: string, value: unknown): void {
    this.header = { ...this.header, [key]: value };
    this.write();
  }

  note(test: string, key: string, value: EvidenceValue): void {
    if (typeof value === 'string' && this.isSecret(value)) throw new Error('refusing to record a known secret as evidence');
    (this.data[test] ??= {})[key] = value;
    this.write();
  }

  private write(): void {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...this.header, results: this.data }, null, 1), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

export interface Lane {
  gates: LaneGates;
  runId: string;
  runDir: string;
  evidence: Evidence;
  build: BuildProof;
  ledger: InflightLedger;
  /** The demo wallets a test may use, in order (E_SWAPS_WALLETS). */
  candidates: readonly WalletName[];
  /** Open (once per worker) and return a demo wallet. */
  wallet(name: WalletName): Promise<LiveWallet>;
  openWallets(): LiveWallet[];
}

/**
 * A wallet's footage directory for this worker, inside this run. A failed
 * test restarts the worker and re-imports the wallet; its frames go to
 * `<wallet>.2`, `.3` and so on, so the earlier session's timeline is kept.
 */
function sessionDir(runDir: string, wallet: WalletName): string {
  let dir = join(runDir, wallet);
  for (let n = 2; existsSync(join(dir, 'timeline.json')) || existsSync(join(dir, 'frames')); n++) dir = join(runDir, `${wallet}.${n}`);
  return dir;
}

export function footageRoot(env: NodeJS.ProcessEnv = process.env): string {
  const label = env.E2E_RUN_LABEL ?? RC.runLabel;
  return resolve(env.E2E_FOOTAGE_DIR ?? join(homedir(), 'Build', 'smirk-e2e', label, 'footage'));
}

function ledgerFile(): string {
  return resolve(process.env.E_SWAPS_LEDGER ?? join(homedir(), 'Build', 'smirk-e2e', 'E-swaps-inflight.json'));
}

function walletFile(): string {
  return resolve(process.env.E2E_WALLET_FILE ?? join(here, '..', '..', 'smoke-tests', 'secrets', 'smoke-mnemonics.env'));
}

function extensionDir(): string {
  const dir = resolve(process.env.EXTENSION_DIST ?? join(here, '..', '..', 'extension', 'dist'));
  if (!existsSync(join(dir, 'manifest.json'))) {
    throw new Error('no unpacked extension at EXTENSION_DIST; unpack the release build under test there');
  }
  return dir;
}

/**
 * Where a failed test stopped, as `file:line` of this lane's own source, read
 * from the stack before the private fixture withholds the error. Never the
 * message: assertion values may carry wallet data.
 */
function failureLine(errors: ReadonlyArray<{ stack?: string; location?: { file: string; line: number } }>): string | null {
  for (const e of errors) {
    if (e.location) return `${basename(e.location.file)}:${e.location.line}`;
    const m = (e.stack ?? '').match(/(e-swaps\.live\.spec\.ts|E-swaps-[\w-]+\.(?:ts|mjs)):(\d+):\d+/);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return null;
}

/** The commit of this test code, and whether the tree had local changes. */
function testSource(): { commit: string; dirty: boolean } | null {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' });
  if (head.status !== 0) return null;
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no', '--', '.'], { cwd: join(here, '..'), encoding: 'utf8' });
  return { commit: head.stdout.trim(), dirty: status.status !== 0 || status.stdout.trim() !== '' };
}

export const test = base.extend<{ laneSegments: void }, { lane: Lane }>({
  lane: [
    async ({}, use) => {
      const gates = laneGates();
      const run = runId();
      const runDir = join(footageRoot(), 'E-swaps', `run-${run}`);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      chmodSync(dirname(runDir), 0o700);
      chmodSync(runDir, 0o700);
      const wallets = new Map<WalletName, Promise<LiveWallet>>();
      const opened: LiveWallet[] = [];
      const evidence = new Evidence(join(runDir, 'evidence.json'), run, (value) =>
        opened.some((w) => w.canary.hit({ text: value, values: [] })),
      );
      const zip = process.env.EXTENSION_ZIP ? resolve(process.env.EXTENSION_ZIP) : undefined;
      let build: BuildProof;
      try {
        build = proveBuild({ distDir: extensionDir(), zipPath: zip, expectZipSha256: process.env.E2E_EXPECT_ZIP_SHA256 });
      } catch (error) {
        // Recorded before the worker fails: the reporter withholds error text.
        evidence.describe('buildRefused', error instanceof Error ? error.message : 'the build proof failed');
        throw error;
      }
      evidence.describe('build', build);
      evidence.describe('testSource', testSource());
      evidence.describe('candidates', walletCandidates());
      const ledger = new InflightLedger(ledgerFile());
      const clear = (process.env.E_SWAPS_CLEAR_INFLIGHT ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (clear.length) {
        for (const r of ledger.clear(clear)) {
          evidence.note('in-flight ledger', `cleared ${r.key}`, `${r.wallet} run ${r.runId} ${r.phase}${r.txid ? ` ${r.txid}` : ''}`);
        }
      }
      const lane: Lane = {
        gates,
        runId: run,
        runDir,
        evidence,
        build,
        ledger,
        candidates: walletCandidates(),
        wallet(name) {
          if (!gates.live) throw new Error('live lane: set E2E_LIVE=1');
          // A failed import is not retried in the same run: each import spends
          // one of the wallet's restore checks on the backend.
          const failed = join(runDir, `${name}.import-failed`);
          if (existsSync(failed)) {
            return Promise.reject(new Error(`${name} could not be imported earlier in this run; not retrying the import`));
          }
          let pending = wallets.get(name);
          if (!pending) {
            pending = LiveWallet.open({
              name,
              extensionDir: extensionDir(),
              walletFile: walletFile(),
              timelineDir: sessionDir(runDir, name),
              runId: run,
              record: gates.footage === 'guarded',
            }).then(
              (w) => {
                opened.push(w);
                return w;
              },
              (error: unknown) => {
                writeFileSync(failed, 'import failed; see the test result\n', { mode: 0o600 });
                throw error;
              },
            );
            wallets.set(name, pending);
          }
          return pending;
        },
        openWallets: () => [...opened],
      };
      try {
        await use(lane);
      } finally {
        for (const w of opened) await w.close().catch(() => {});
      }
    },
    { scope: 'worker', timeout: 30 * 60_000 },
  ],

  // Chapter boundaries, the end-of-test settle, and each test's outcome.
  laneSegments: [
    async ({ lane }, use, testInfo) => {
      const from = Date.now();
      try {
        await use();
      } finally {
        // The last screen each wallet acted on is held settled before the
        // chapter ends, whether the test passed or not.
        await Promise.all(lane.openWallets().map((w) => w.footage.settleIfUnheld().catch(() => {})));
        for (const w of lane.openWallets()) w.footage.testSegment(testInfo.title, from, Date.now());
        // The private reporter prints no reasons; keep each skip's static
        // reason, and each failure's source line, with the run's evidence.
        const skip = testInfo.annotations.find((a) => a.type === 'skip');
        if (testInfo.status === 'skipped' && skip?.description) lane.evidence.note(testInfo.title, 'skipped', skip.description);
        const at = failureLine(testInfo.errors);
        if (at) lane.evidence.note(testInfo.title, 'failed at', at);
        lane.evidence.note(testInfo.title, 'status', testInfo.status ?? 'unknown');
      }
    },
    { auto: true },
  ],
});

export const expect = test.expect;
