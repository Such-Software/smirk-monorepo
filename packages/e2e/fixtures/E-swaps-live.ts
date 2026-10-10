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
 * Paths: EXTENSION_DIST (the unpacked release build under test), and
 * E2E_WALLET_FILE (the custody file; required in a worktree, which has none).
 * Output: E2E_FOOTAGE_DIR, default ~/Build/smirk-e2e/<E2E_RUN_LABEL>/footage,
 * with this area under E-swaps/ (0700): one directory per wallet holding
 * frames/ and timeline.json, plus evidence.json for the run's public results.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from './private-test.js';
import { BACKEND_URL, isSharedBackend } from './extension.js';
import { LiveWallet, type WalletName } from './E-swaps-wallets.js';

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
    prodWrites: !isSharedBackend() || env.ALLOW_PROD_WRITES === '1',
    footage: footage === 'guarded' ? 'guarded' : 'off',
  };
}

/** Why a live test must not run, or null. Static reasons only. */
export function liveRefusal(gates: LaneGates, needsMoney: boolean): string | null {
  if (!gates.live) return 'live lane: set E2E_LIVE=1 to drive the real wallet against the configured backend';
  if (!needsMoney) return null;
  if (!gates.money) return 'live money: set E2E_LIVE_MONEY=1 (this test broadcasts real transactions from a demo wallet)';
  if (!gates.prodWrites) return 'shared backend: set ALLOW_PROD_WRITES=1 as well to broadcast against it';
  return null;
}

/** Public results of the run (txids, states, amounts). Never secrets. */
export class Evidence {
  private readonly data: Record<string, Record<string, string | number | boolean>> = {};

  constructor(private readonly file: string, private readonly isSecret: (value: string) => boolean) {
    // A failed test restarts the worker; keep what the earlier worker wrote.
    if (existsSync(file)) {
      try {
        Object.assign(this.data, (JSON.parse(readFileSync(file, 'utf8')) as { results?: Evidence['data'] }).results ?? {});
      } catch {
        // An unreadable file is replaced, not trusted.
      }
    }
  }

  note(test: string, key: string, value: string | number | boolean): void {
    if (typeof value === 'string' && this.isSecret(value)) throw new Error('refusing to record a known secret as evidence');
    (this.data[test] ??= {})[key] = value;
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ area: 'E-swaps', backend: BACKEND_URL, results: this.data }, null, 1), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

export interface Lane {
  gates: LaneGates;
  areaDir: string;
  evidence: Evidence;
  /** Open (once per worker) and return a demo wallet. */
  wallet(name: WalletName): Promise<LiveWallet>;
  openWallets(): LiveWallet[];
}

/**
 * A wallet's footage directory for this worker. A failed test restarts the
 * worker and re-imports the wallet; its frames go to `<wallet>.2`, `.3` and so
 * on, so the earlier session's timeline is never overwritten.
 */
function sessionDir(areaDir: string, wallet: WalletName): string {
  let dir = join(areaDir, wallet);
  for (let n = 2; existsSync(join(dir, 'timeline.json')) || existsSync(join(dir, 'frames')); n++) dir = join(areaDir, `${wallet}.${n}`);
  return dir;
}

function footageRoot(): string {
  const label = process.env.E2E_RUN_LABEL ?? 'v0.3.1-run-11204';
  return resolve(process.env.E2E_FOOTAGE_DIR ?? join(homedir(), 'Build', 'smirk-e2e', label, 'footage'));
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

export const test = base.extend<{ laneSegments: void }, { lane: Lane }>({
  lane: [
    async ({}, use) => {
      const gates = laneGates();
      const areaDir = join(footageRoot(), 'E-swaps');
      mkdirSync(areaDir, { recursive: true, mode: 0o700 });
      chmodSync(areaDir, 0o700);
      const wallets = new Map<WalletName, Promise<LiveWallet>>();
      const opened: LiveWallet[] = [];
      const evidence = new Evidence(join(areaDir, 'evidence.json'), (value) =>
        opened.some((w) => w.canary.hit({ text: value, values: [] })),
      );
      const lane: Lane = {
        gates,
        areaDir,
        evidence,
        wallet(name) {
          if (!gates.live) throw new Error('live lane: set E2E_LIVE=1');
          // A failed import is not retried in the same run: each import spends
          // one of the wallet's restore checks on the backend.
          const failed = join(areaDir, `${name}.import-failed.${process.env.E_SWAPS_RUN_ID ?? 'run'}`);
          if (existsSync(failed)) {
            return Promise.reject(new Error(`${name} could not be imported earlier in this run; not retrying the import`));
          }
          let pending = wallets.get(name);
          if (!pending) {
            pending = LiveWallet.open({
              name,
              extensionDir: extensionDir(),
              walletFile: walletFile(),
              timelineDir: sessionDir(areaDir, name),
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

  // Chapter boundaries for every open wallet's timeline.
  laneSegments: [
    async ({ lane }, use, testInfo) => {
      const from = Date.now();
      try {
        await use();
      } finally {
        for (const w of lane.openWallets()) w.footage.testSegment(testInfo.title, from, Date.now());
        // The private reporter prints no reasons; keep each skip's static
        // reason with the run's evidence so a skip is never silent.
        const skip = testInfo.annotations.find((a) => a.type === 'skip');
        if (testInfo.status === 'skipped' && skip?.description) lane.evidence.note(testInfo.title, 'skipped', skip.description);
        lane.evidence.note(testInfo.title, 'status', testInfo.status ?? 'unknown');
      }
    },
    { auto: true },
  ],
});

export const expect = test.expect;
