/**
 * The F-legacy-recovery live lane: gates, move fixtures, preflight, evidence
 * and the demo-wallet lock. No Playwright runtime here, so the lane config can
 * import it and refuse, naming the cause, before anything starts, and a node
 * test can exercise it (F-legacy-recovery-lane.test.mjs).
 *
 * Gates, each an explicit opt-in (closed by default):
 *   E2E_LANE=F-legacy-recovery  set only by F-legacy-recovery.live.config.ts. The
 *                               spec declares nothing in any other invocation, so
 *                               this lane never shares a run (or a wallet
 *                               profile) with another live lane.
 *   E2E_LIVE=1                  drive the demo wallets against BACKEND_URL.
 *   ALLOW_PROD_WRITES=1         write to a shared backend: old-server sign-in
 *                               (F3, which may create an empty v0.2 account),
 *                               LWS registration of older addresses (F2, F4) and
 *                               every broadcast.
 *   E2E_LIVE_MONEY=1            move real coins among alice, bob and carol (F4 to F6).
 *   FOOTAGE=guarded             record (fixtures/F-legacy-recovery-footage.ts).
 *
 * A test skips only with a reason that starts "opt-in: " (an approval above is
 * not given) or "no fixture: " (the thing it needs does not exist). The skip
 * guard excuses exactly those two for this lane; any other skip, for example a
 * funder short of coins, still fails the run.
 */

import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PINNED_CHROME_ZIP_SHA256, verifyUnpackedRelease } from './F-legacy-recovery-release.mjs';

export const LANE_ID = 'F-legacy-recovery';

export const WALLET_NAMES = Object.freeze(['alice', 'bob', 'carol']);

export const SKIP_OPT_IN = 'opt-in: ';
export const SKIP_NO_FIXTURE = 'no fixture: ';
export const optIn = (why) => `${SKIP_OPT_IN}${why}`;
export const noFixture = (why) => `${SKIP_NO_FIXTURE}${why}`;

/** Bound on any single wait for an element or action: a missing screen fails with its cause, not at the test timeout. */
export const ACTION_TIMEOUT_MS = 2 * 60_000;

// ── Gates ────────────────────────────────────────────────────────────────────

/** Same rule as fixtures/extension.ts isSharedBackend: anything but loopback is shared. */
function sharedBackend(env) {
  try {
    const h = new URL(env.BACKEND_URL ?? 'http://127.0.0.1:8080/api/v1').hostname;
    return !(h === '127.0.0.1' || h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local'));
  } catch {
    return true;
  }
}

export function laneGates(env = process.env) {
  const live = env.E2E_LIVE === '1';
  return {
    declared: live && env.E2E_LANE === LANE_ID,
    live,
    money: env.E2E_LIVE_MONEY === '1',
    prodWrites: !sharedBackend(env) || !!env.ALLOW_PROD_WRITES,
  };
}

/** Why a test that writes to the backend must not run, or null. */
export function writeRefusal(g = laneGates()) {
  return g.prodWrites ? null : optIn('writes to a shared backend: set ALLOW_PROD_WRITES=1');
}

/** Why a test that moves coins must not run, or null. */
export function moneyRefusal(g = laneGates()) {
  if (!g.money) return optIn('moves real coins among the demo wallets: set E2E_LIVE_MONEY=1');
  return writeRefusal(g);
}

// ── Move fixtures (F4) ──────────────────────────────────────────────────────

/**
 * Small amounts, clear of dust and of the move's own fee, among the demo
 * wallets only. The cap refuses a typo (0.2 for 0.0002) before anything moves.
 */
const MOVE_DEFAULTS = Object.freeze({
  btc: { kind: 'utxo', funder: 'bob', target: 'alice', source: 'm44', amount: '0.00005', cap: '0.0002', decimals: 8 },
  ltc: { kind: 'utxo', funder: 'bob', target: 'alice', source: 'm44', amount: '0.0002', cap: '0.002', decimals: 8 },
  xmr: { kind: 'cryptonote', funder: 'alice', target: 'bob', source: 'v2', amount: '0.002', cap: '0.01', decimals: 12 },
  wow: { kind: 'cryptonote', funder: 'alice', target: 'bob', source: 'v2', amount: '0.2', cap: '2', decimals: 11 },
});

/** Default: one UTXO move (LTC at m/44') and one Cryptonote move (WOW at v2), homero's case. */
const DEFAULT_MOVE_ASSETS = 'ltc,wow';

/** A decimal string as atomic units; refuses anything that is not a plain decimal. */
export function toAtomic(amount, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(amount).trim());
  if (!m) throw new Error(`"${amount}" is not a plain decimal amount`);
  const fraction = m[2] ?? '';
  if (fraction.length > decimals) throw new Error(`"${amount}" has more than ${decimals} decimals`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

function walletFrom(env, name, fallback) {
  const value = env[name] ?? fallback;
  if (!WALLET_NAMES.includes(value)) throw new Error(`${name} must be one of ${WALLET_NAMES.join(', ')}`);
  return value;
}

/**
 * The configured F4 moves. Per asset: E2E_LEGACY_MOVE_<ASSET>_FUNDER, _TARGET,
 * _AMOUNT (at most the cap) and, for XMR/WOW, _SOURCE (v1 or v2). Invalid
 * configuration throws, so a bad value refuses the run instead of moving coins.
 */
export function moveScenarios(env = process.env) {
  const assets = (env.E2E_LEGACY_MOVE_ASSETS ?? DEFAULT_MOVE_ASSETS)
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const out = [];
  for (const asset of assets) {
    if (!Object.hasOwn(MOVE_DEFAULTS, asset)) throw new Error(`E2E_LEGACY_MOVE_ASSETS: ${asset} is not one of btc, ltc, xmr, wow`);
    if (out.some((s) => s.asset === asset)) throw new Error(`E2E_LEGACY_MOVE_ASSETS lists ${asset} twice`);
    const d = MOVE_DEFAULTS[asset];
    const prefix = `E2E_LEGACY_MOVE_${asset.toUpperCase()}`;
    const funder = walletFrom(env, `${prefix}_FUNDER`, d.funder);
    const target = walletFrom(env, `${prefix}_TARGET`, d.target);
    if (funder === target) throw new Error(`${prefix}: the funder and the target must be different demo wallets`);
    let source = d.source;
    if (d.kind === 'cryptonote') {
      source = env[`${prefix}_SOURCE`] ?? d.source;
      if (source !== 'v1' && source !== 'v2') throw new Error(`${prefix}_SOURCE must be v1 or v2`);
    }
    const amount = String(env[`${prefix}_AMOUNT`] ?? d.amount).trim();
    const amountAtomic = toAtomic(amount, d.decimals);
    if (amountAtomic <= 0n) throw new Error(`${prefix}_AMOUNT must be above zero`);
    if (amountAtomic > toAtomic(d.cap, d.decimals)) {
      throw new Error(`${prefix}_AMOUNT ${amount} is above the ${d.cap} ${asset.toUpperCase()} cap for a move fixture`);
    }
    out.push({ asset, kind: d.kind, funder, target, source, amount, amountAtomic, decimals: d.decimals });
  }
  return out;
}

/**
 * The skip guard's floor for this lane: tests that cannot skip with an
 * expected reason once their gates are open (F1 for each wallet, the three
 * alice/bob F1 behaviours, F3 for each wallet with writes, F4 for each move
 * with money). F2, F5, F5b and F6 may skip for want of a fixture.
 */
export function expectedExecuted(g, moves) {
  let n = WALLET_NAMES.length + 3;
  if (g.prodWrites) n += WALLET_NAMES.length;
  if (g.prodWrites && g.money) n += moves;
  return n;
}

// ── Preflight ────────────────────────────────────────────────────────────────

export const DEFAULT_RELEASE_ZIP = join(homedir(), 'Build', 'smirk-release', 'v0.3.1-run-11204', 'staged', 'smirk-wallet-chrome-v0.3.1.zip');

/** Run identity, for output paths only. */
export const FOOTAGE_RUN = process.env.E2E_FOOTAGE_RUN ?? 'v0.3.1-run-11204';

export function footageRoot() {
  return resolve(process.env.E2E_FOOTAGE_DIR ?? join(homedir(), 'Build', 'smirk-e2e', FOOTAGE_RUN, 'footage'));
}

/** True when this run records. Any other FOOTAGE value is refused, not ignored. */
export function footageEnabled(env = process.env) {
  const mode = (env.FOOTAGE ?? '').trim();
  if (mode === '' || mode === 'off') return false;
  if (mode === 'guarded') return true;
  throw new Error('FOOTAGE accepts only "guarded" (the per-frame guarded recorder) or "off".');
}

export function assertOwnerOnlyFile(file, what) {
  if (!existsSync(file)) throw new Error(`${what} not found at ${file}`);
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error(`${what} must be a regular owner-only (0600) file owned by this user`);
  }
}

/**
 * Every cheap refusal, before a browser starts: the lane is live, no phrase is
 * in the environment, the custody file is owner-only, FOOTAGE is valid, the
 * move configuration is sane, EXTENSION_DIST is byte for byte the pinned
 * release zip, and no other run holds a demo wallet. Throws, naming the cause.
 */
export function lanePreflight(env = process.env) {
  if (env.E2E_LIVE !== '1') {
    throw new Error('The F-legacy-recovery lane drives the demo wallets against a real backend: set E2E_LIVE=1.');
  }
  const leaked = Object.keys(env).filter((k) => /^SMOKE_.*MNEMONIC$/.test(k));
  if (leaked.length) {
    throw new Error(
      `refusing: ${leaked.join(', ')} is set in the environment, so every child process (browsers included) ` +
        'inherits the phrase. Unset it and pass the custody file path in E2E_WALLET_FILE instead.',
    );
  }
  const custody = env.E2E_WALLET_FILE;
  if (!custody) throw new Error('E2E_WALLET_FILE must name the owner-only demo wallet custody file.');
  assertOwnerOnlyFile(resolve(custody), 'the wallet custody file (E2E_WALLET_FILE)');
  footageEnabled(env);
  moveScenarios(env);
  const dir = env.EXTENSION_DIST;
  if (!dir) throw new Error('EXTENSION_DIST must name the unpacked release extension under test.');
  const facts = verifyUnpackedRelease({
    dir,
    zip: env.E2E_RELEASE_ZIP ?? DEFAULT_RELEASE_ZIP,
    expectedSha256: (env.E2E_RELEASE_ZIP_SHA256 ?? PINNED_CHROME_ZIP_SHA256).toLowerCase(),
  });
  const expected = env.E2E_EXPECT_VERSION ?? '0.3.1';
  if (facts.version !== expected) throw new Error(`EXTENSION_DIST is version ${facts.version || 'unknown'}, expected ${expected}.`);
  // In the runner's main process (no worker index) no lock of this run is held
  // yet, so any live holder is another run. A worker leaves this to
  // acquireWalletLock, which waits for this lane's previous worker.
  for (const name of env.TEST_WORKER_INDEX === undefined ? WALLET_NAMES : []) {
    const holder = walletLockHolder(name);
    if (holder) {
      throw new Error(
        `demo wallet ${name} is in use by another live run (pid ${holder.pid}, lane ${holder.lane ?? 'unknown'}). Run live lanes one at a time.`,
      );
    }
  }
  return facts;
}

// ── Evidence ─────────────────────────────────────────────────────────────────

/**
 * Public results of the run (statuses, skip reasons, txids, observations),
 * appended one JSON line at a time so a restarted worker never overwrites an
 * earlier one. The private reporter prints no reasons; this file keeps them.
 */
export class LaneEvidence {
  #isSecret;

  constructor(isSecret) {
    this.#isSecret = isSecret;
    const dir = join(footageRoot(), LANE_ID);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'evidence.jsonl');
  }

  note(test, key, value) {
    if (typeof value === 'string' && this.#isSecret(value)) throw new Error('refusing to record a known secret as evidence');
    const line = JSON.stringify({ at: new Date().toISOString(), worker: process.env.TEST_WORKER_INDEX ?? '0', test, key, value });
    appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
  }
}

// ── Demo-wallet lock ─────────────────────────────────────────────────────────

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

const lockDir = () => resolve(process.env.E2E_LOCK_DIR ?? join(homedir(), 'Build', 'smirk-e2e', 'locks'));
const lockFile = (name) => join(lockDir(), `demo-wallet-${name}.lock`);

/** The live process holding a demo wallet's lock, or null (no lock, or its process is gone). */
export function walletLockHolder(name) {
  try {
    const held = JSON.parse(readFileSync(lockFile(name), 'utf8'));
    return typeof held.pid === 'number' && alive(held.pid) ? { pid: held.pid, ...(held.lane ? { lane: held.lane } : {}) } : null;
  } catch {
    return null;
  }
}

/**
 * Hold a demo wallet for this process, so two live runs never open two profiles
 * of one wallet and spend the same coins twice. The lock lives in
 * E2E_LOCK_DIR (default ~/Build/smirk-e2e/locks), one file per wallet, for any
 * live lane to share. A lock whose process is gone is reclaimed; one held by
 * this lane's previous worker (a failed test restarts the worker) is awaited.
 * Returns the release function.
 */
export async function acquireWalletLock(name) {
  mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
  const file = lockFile(name);
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, lane: LANE_ID, at: new Date().toISOString() }));
      closeSync(fd);
      return () => {
        try {
          if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file);
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    let holder = {};
    try {
      holder = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // Unreadable or mid-write: treat as held for now.
    }
    if (typeof holder.pid === 'number' && !alive(holder.pid)) {
      try {
        unlinkSync(file);
      } catch {
        // Another process reclaimed it first.
      }
      continue;
    }
    const waitable = typeof holder.pid !== 'number' || holder.lane === LANE_ID;
    if (!waitable || Date.now() > deadline) {
      throw new Error(
        `demo wallet ${name} is in use by another live run (pid ${holder.pid ?? 'unknown'}, lane ${holder.lane ?? 'unknown'}). ` +
          `Run live lanes one at a time; remove ${file} only if that run is gone.`,
      );
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
