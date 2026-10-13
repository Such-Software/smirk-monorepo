#!/usr/bin/env node
/**
 * The Smirk Wallet v0.3.1 release run: every live area, A to H, one after
 * another in the order of the release survey, against the STAGED release
 * candidate (fixtures/release-candidate.json) and the production backend, recorded under the
 * owner's video policy. `npm run test:live-v031 -w @smirk/e2e` runs it.
 *
 * Order. The survey interleaves areas so that confirmation waits overlap;
 * each area is one reviewed lane with its own config, ledger, rescue and
 * teardown, so this runner keeps every lane whole and runs them in the order
 * the survey first needs them, which also keeps every dependency it names:
 *
 *   step 0   preflight     release hashes, unpack, capabilities and prices,
 *                          every lane's offline guards, privacy regression,
 *                          disk, tools, custody, the owner's decisions
 *   step 1   baseline      B: every balance and the funding check, no money
 *   step 2   A             onboarding, lock policy, sign-in, identity
 *   step 3a  E             swaps: THORChain BTC to LTC first, quotes (4b),
 *                          LTC to BTC once that lands (7), NonLogs (8, flagged)
 *   step 3b  B             sends, receives and history: each coin's three hops
 *                          (3b, 6, 9) and every history sheet (10)
 *   step 4b  D             messaging and federation, before any tip claim can
 *                          still be confirming into carol's balances, which D
 *                          compares exactly
 *   step 3c  C             link, npub, name and federated tips, forged wraps,
 *                          claims after confirmations and clawbacks (3c to 5)
 *   step 4b  G             premium labels, invoices, checking; the purchase
 *                          in LTC (11, flagged) after E's LTC to BTC
 *   step 4b  F             legacy discovery; seeded moves (12, flagged)
 *   step 13  H-firefox     Firefox, Firefox with RFP prefs, Chromium (staged
 *                          Firefox and Chrome zips)
 *   step 13  H-macos       the macOS desktop smoke; on the Mac only
 *   step 14  closeout      B: every final balance held 25 s; then the summary
 *
 * Two sends from one wallet never overlap: one lane runs at a time, each with
 * one worker. The whole run takes most of a day: confirmation waits and the
 * holds dominate.
 *
 * Gates. Each is explicit and none is inferred. The run refuses, naming the
 * cause, unless the environment has E2E_LIVE=1, E2E_LIVE_MONEY=1,
 * ALLOW_PROD_WRITES=1, E2E_LIVE_RELAY=1 and FOOTAGE=guarded, the custody file
 * in E2E_WALLET_FILE (a path, never a value; read in-process by each lane),
 * and the owner's yes or no on every decision below. A decision with no
 * answer refuses; it is never defaulted.
 *
 *   V031_IDENTITY_WRITES   new-wallet and handle writes (A creates a wallet and
 *                          claims a handle; D links seed npubs and may claim
 *                          E2E_LIVE_CAROL_HANDLE; C may claim E2E_CLAIM_BOB_HANDLE)
 *   V031_FEDERATION_B      the federation backend B in FED_BACKEND_URL (C's
 *                          federated tips, D's trip to B); "no" records the
 *                          gap as acknowledged (E2E_LIVE_ACK_GAPS=federation)
 *   V031_NONLOGS_SWAP      the real NonLogs XMR to WOW swap in E
 *   V031_TROCADOR_SWAP     the real Trocador LTC to XMR swap in E (capped,
 *                          fixtures/E-swaps-trocador.mjs)
 *   V031_PREMIUM_PURCHASE  the premium purchase in G (needs G_PREMIUM_CHECKOUT_HOST)
 *   V031_LEGACY_FIXTURE    F's seeded moves among the demo wallets
 *   V031_FEED_POST         any public feed post (D, and G after a purchase)
 *
 * Lane-specific settings (FED_BACKEND_URL, E2E_FOREIGN_NIP05, the handle
 * names, G_PREMIUM_*, E_SWAPS_ACCEPT_KNOWN_ISSUES, E2E_ACCEPT_DIRTY_BUILD,
 * E2E_LEGACY_*) pass through to the lane that reads them, unless a decision
 * above closes them. BACKEND_URL defaults to production; V031_STAGED_DIR to
 * the candidate's staging directory; V031_FONT to a caption font found here.
 *
 * Output, all 0700 directories and 0600 files, nothing uploaded or promoted:
 *   ~/Build/smirk-e2e/v031-run/<UTC date>/     (--run-dir overrides)
 *     run.json                 release, source commit, backend, host, decisions
 *     preflight/               capabilities and prices snapshots
 *     release/chrome/          the verified, unpacked staged Chrome zip
 *     phases/<phase>.json      every attempt: start, end, exit codes, decisions
 *     logs/<phase>-<n>.log     the lane's own output (outcomes and progress)
 *     logs/<phase>-<n>.private.jsonl  why each test failed, by shape only
 *                              (fixtures/failure-record.mjs), and every wallet
 *                              the lane brought back Home on reopening
 *     <area>/                  that lane's footage, video, ledgers and evidence
 *     summary.json             every phase's state and where its video is
 *
 * Usage (from packages/e2e, or with -w @smirk/e2e):
 *   node scripts/live-v031.mjs --list
 *   node scripts/live-v031.mjs [--run-dir DIR] [--resume] [--from PHASE]
 *     [--only P1,P2] [--except P1,P2] [--keep-going] [--preflight-only]
 *
 * A failed phase stops the run unless --keep-going; --resume continues the
 * same run directory, skipping phases that already passed. If a send's
 * broadcast state is unknown, never start it again by hand: each money lane
 * resumes from its own ledger (B's spend ledger, C's tip ledger and rescue,
 * E's in-flight swap ledger).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RC } from '../fixtures/release-candidate.mjs';

const E2E_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The release candidate under test (fixtures/release-candidate.json). Hashes are of the staged zips. */
export const RELEASE = Object.freeze({
  version: RC.version,
  run: Number(RC.run),
  sourceCommit: RC.sourceCommit.slice(0, 8),
  stagedDir: RC.stagedDir,
  chromeZip: RC.chromeZip.file,
  chromeSha256: RC.chromeZip.sha256,
  firefoxZip: RC.firefoxZip.file,
  firefoxSha256: RC.firefoxZip.sha256,
});

export const PRODUCTION_BACKEND = 'https://api.smirk.cash/api/v1';
export const RUN_ROOT = join(homedir(), 'Build', 'smirk-e2e', 'v031-run');
export const MIN_FREE_BYTES = 20 * 1024 ** 3;
export const WALLET_VARIABLES = Object.freeze(['SMOKE_ALICE_MNEMONIC', 'SMOKE_BOB_MNEMONIC', 'SMOKE_CAROL_MNEMONIC']);
export const REQUIRED_GATES = Object.freeze({
  E2E_LIVE: '1',
  E2E_LIVE_MONEY: '1',
  ALLOW_PROD_WRITES: '1',
  E2E_LIVE_RELAY: '1',
  FOOTAGE: 'guarded',
});

/** The owner's decisions (survey step 0). Each must be answered yes or no; none has a default. */
export const DECISIONS = Object.freeze([
  { env: 'V031_IDENTITY_WRITES', key: 'identityWrites', what: 'new-wallet and handle writes (A, C, D)' },
  { env: 'V031_FEDERATION_B', key: 'federationB', what: 'the federation backend B (C, D)' },
  { env: 'V031_NONLOGS_SWAP', key: 'nonlogsSwap', what: 'the real NonLogs XMR to WOW swap (E)' },
  { env: 'V031_TROCADOR_SWAP', key: 'trocadorSwap', what: 'the real Trocador LTC to XMR swap (E)' },
  { env: 'V031_PREMIUM_PURCHASE', key: 'premiumPurchase', what: 'the premium purchase in LTC (G)' },
  { env: 'V031_LEGACY_FIXTURE', key: 'legacyFixture', what: 'the seeded legacy moves (F)' },
  { env: 'V031_FEED_POST', key: 'feedPost', what: 'any public feed post (D, G)' },
]);

/** The E tests the swap decisions govern (tests/live/e-swaps.live.spec.ts). */
export const NONLOGS_SWAP_TITLE = 'NonLogs XMR to WOW: small real swap';
export const TROCADOR_SWAP_TITLE = 'Trocador LTC to XMR: real swap';
/** E's test count (E-swaps.live.config.ts) with every decision yes. */
export const E_TESTS = 11;

/** The E tests a "no" deselects, as titles. */
export function eDeselected(decisions) {
  return [...(decisions.nonlogsSwap ? [] : [NONLOGS_SWAP_TITLE]), ...(decisions.trocadorSwap ? [] : [TROCADOR_SWAP_TITLE])];
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Variables each lane sets for itself; an inherited value would leak one lane's state into another. */
const LANE_OWNED = Object.freeze([
  'E2E_MIN_EXECUTED',
  'E2E_LANE',
  'SMIRK_E2E_LANE',
  'C_TIPS_INVOCATION',
  'E_SWAPS_RUN_ID',
  'EXTENSION_DIST',
  'E2E_FOOTAGE_DIR',
  'FOOTAGE_DIR',
  'E2E_RUN_DIR',
  'E2E_LIVE_RUN_DIR',
  'E2E_REPORTS_DIR',
  'E2E_LIVE_RUN_ID',
  'E2E_PRIVATE_LOG',
]);

const FONTS = ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'];

/**
 * The phases after preflight, in run order. `env` returns overrides: a string
 * sets a variable, `null` removes it. Paths are under the run directory.
 */
export const PHASES = Object.freeze([
  {
    id: 'baseline',
    step: '1',
    // The B lane, in its own run directory: it moves no money.
    area: 'baseline',
    title: 'Baseline: every balance of alice, bob and carol held 25 s, and the funding check, before any money moves',
    kind: 'playwright',
    config: 'B-send-receive-history.live.config.ts',
    grep: "funding: |USD in every coin header",
    env: (ctx) => bLaneEnv(ctx, join(ctx.runDir, 'baseline')),
    encode: (ctx) => [bEncode(ctx, join(ctx.runDir, 'baseline'))],
  },
  {
    id: 'A',
    step: '2',
    area: 'A-onboarding-identity',
    title: 'Onboarding, lock policy, website sign-in and identity',
    kind: 'playwright',
    config: 'playwright.live.config.ts',
    env: (ctx) => ({
      E2E_EXTENSION_ZIP: ctx.chromeZip,
      E2E_EXTENSION_SHA256: RELEASE.chromeSha256,
      E2E_EXPECT_VERSION: RELEASE.version,
      E2E_WALLET_FILE: ctx.walletFile,
      E2E_FOOTAGE_DIR: join(ctx.runDir, 'A-onboarding-identity', 'footage'),
      // Creating a wallet, claiming a handle and publishing are A's writes.
      ALLOW_PROD_WRITES: ctx.decisions.identityWrites ? '1' : null,
    }),
    // The guarded recorder encodes each page when it stops (FOOTAGE_ENCODE stays on).
    encode: () => [],
  },
  {
    id: 'E',
    step: '3a, 4b, 7, 8',
    area: 'E-swaps',
    title: 'Swaps: THORChain both ways for real, quotes, Trocador, NonLogs, Where to trade',
    kind: 'playwright',
    config: 'E-swaps.live.config.ts',
    grepInvert: (ctx) => {
      const titles = eDeselected(ctx.decisions);
      return titles.length ? titles.map(escapeRegExp).join('|') : null;
    },
    env: (ctx) => ({
      EXTENSION_DIST: ctx.chromeDir,
      EXTENSION_ZIP: ctx.chromeZip,
      E2E_EXPECT_ZIP_SHA256: RELEASE.chromeSha256,
      E2E_WALLET_FILE: ctx.walletFile,
      E2E_RUN_LABEL: ctx.runId,
      E2E_FOOTAGE_DIR: join(ctx.runDir, 'E-swaps', 'footage'),
      E_SWAPS_RUN_ID: ctx.attemptId,
      E2E_MIN_EXECUTED: String(E_TESTS - eDeselected(ctx.decisions).length),
      // The lane re-checks the owner's answer itself; a "no" also deselects the test.
      V031_TROCADOR_SWAP: ctx.decisions.trocadorSwap ? 'yes' : null,
    }),
    encode: (ctx) => [
      node('scripts/E-swaps-encode.mjs', ['--run', ctx.attemptId, '--area', join(ctx.runDir, 'E-swaps', 'footage', 'E-swaps'), '--font', ctx.font]),
    ],
  },
  {
    id: 'B',
    step: '3b, 6, 9, 10',
    area: 'B-send-receive-history',
    title: 'Sends, receives and history: three hops per coin among the demo wallets, every history sheet',
    kind: 'playwright',
    config: 'B-send-receive-history.live.config.ts',
    env: (ctx) => bLaneEnv(ctx, join(ctx.runDir, 'B-send-receive-history')),
    encode: (ctx) => [bEncode(ctx, join(ctx.runDir, 'B-send-receive-history'))],
  },
  {
    id: 'D',
    step: '4b',
    area: 'D-messaging-federation',
    title: 'Messaging and federation: DMs, background delivery, burners, outside Nostr, backend B',
    kind: 'playwright',
    config: 'D-messaging-federation.live.config.ts',
    env: (ctx) => {
      const d = ctx.decisions;
      return {
        EXTENSION_DIST: ctx.chromeDir,
        E2E_EXPECT_VERSION: RELEASE.version,
        E2E_WALLET_FILE: ctx.walletFile,
        E2E_RUN_LABEL: ctx.runId,
        E2E_FOOTAGE_DIR: join(ctx.runDir, 'D-messaging-federation', 'footage', 'raw'),
        E2E_REPORTS_DIR: join(ctx.runDir, 'D-messaging-federation', 'reports'),
        E2E_LIVE_LINK: d.identityWrites ? '1' : null,
        E2E_LIVE_CAROL_HANDLE: d.identityWrites ? (ctx.env.E2E_LIVE_CAROL_HANDLE ?? null) : null,
        E2E_LIVE_FEED_POST: d.feedPost ? '1' : null,
        FED_BACKEND_URL: d.federationB ? ctx.env.FED_BACKEND_URL : null,
        FED_BACKEND_APPROVED: d.federationB ? '1' : null,
        FED_CAROL_HANDLE: d.federationB && d.identityWrites ? (ctx.env.FED_CAROL_HANDLE ?? null) : null,
        E2E_LIVE_ACK_GAPS: ackGaps(ctx),
        // Every selected test must run; with the federation gap acknowledged
        // its skips are listed, not counted, and any other skip still fails.
        E2E_MIN_EXECUTED: ackGaps(ctx)?.split(',').includes('federation') ? '1' : 'selected',
      };
    },
    encode: (ctx) => [
      node('scripts/D-messaging-federation-encode.mjs', [
        '--footage', join(ctx.runDir, 'D-messaging-federation', 'footage', 'raw'),
        '--out', join(ctx.runDir, 'D-messaging-federation', 'footage', 'video'),
        '--font', ctx.font,
      ]),
    ],
  },
  {
    id: 'C',
    step: '3c, 3d, 4a, 4b, 5',
    area: 'C-tips',
    title: 'Tips: public link tips, targeted tips by npub and name, federated tips, forged wraps, claims and clawbacks',
    kind: 'playwright',
    config: 'C-tips.live.config.ts',
    env: (ctx) => {
      const d = ctx.decisions;
      return {
        E2E_RUN_DIR: join(ctx.runDir, 'C-tips'),
        E2E_RUN_LABEL: ctx.runId,
        E2E_RELEASE_ZIP: ctx.chromeZip,
        E2E_RELEASE_SHA256: RELEASE.chromeSha256,
        E2E_RELEASE_VERSION: RELEASE.version,
        SMOKE_WALLET_FILE: ctx.walletFile,
        E2E_CLAIM_BOB_HANDLE: d.identityWrites ? (ctx.env.E2E_CLAIM_BOB_HANDLE ?? null) : null,
        FED_BACKEND_URL: d.federationB ? ctx.env.FED_BACKEND_URL : null,
        E2E_FOREIGN_NIP05: d.federationB ? (ctx.env.E2E_FOREIGN_NIP05 ?? null) : null,
        E2E_LIVE_ACK_GAPS: ackGaps(ctx),
      };
    },
    // The lane's teardown encodes and checks every hold, and keeps the
    // profiles with RECOVERY.md while any tip of the run is unsettled.
    encode: () => [],
  },
  {
    id: 'G',
    step: '4b, 11',
    area: 'G-premium',
    title: 'Premium: plan labels, invoices, automatic checking and abandon; the purchase when approved',
    kind: 'playwright',
    config: 'G-premium.live.config.ts',
    env: (ctx) => {
      const d = ctx.decisions;
      return {
        EXTENSION_DIST: ctx.chromeDir,
        LIVE_EXPECT_VERSION: RELEASE.version,
        LIVE_WALLET_FILE: ctx.walletFile,
        FOOTAGE_DIR: join(ctx.runDir, 'G-premium', 'footage'),
        E2E_LIVE_MONEY: d.premiumPurchase ? '1' : null,
        E2E_PREMIUM_PURCHASE: d.premiumPurchase ? '1' : null,
        E2E_PREMIUM_POST: d.premiumPurchase && d.feedPost ? '1' : null,
      };
    },
    encode: (ctx) =>
      newDirs(join(ctx.runDir, 'G-premium', 'footage', 'G-premium'), ctx.attemptStartedAt).map((dir) =>
        node('scripts/G-premium-footage.mjs', ['--run', dir, '--font', ctx.font]),
      ),
  },
  {
    id: 'F',
    step: '4b, 12',
    area: 'F-legacy-recovery',
    title: 'Legacy recovery: older addresses on all three wallets, old-server claims; seeded moves when approved',
    kind: 'playwright',
    config: 'F-legacy-recovery.live.config.ts',
    env: (ctx) => ({
      EXTENSION_DIST: ctx.chromeDir,
      E2E_RELEASE_ZIP: ctx.chromeZip,
      E2E_RELEASE_ZIP_SHA256: RELEASE.chromeSha256,
      E2E_EXPECT_VERSION: RELEASE.version,
      E2E_WALLET_FILE: ctx.walletFile,
      E2E_FOOTAGE_DIR: join(ctx.runDir, 'F-legacy-recovery', 'footage'),
      E2E_FOOTAGE_RUN: ctx.runId,
      // Without the approval F's moves skip with "opt-in: ", which the skip guard excuses.
      E2E_LIVE_MONEY: ctx.decisions.legacyFixture ? '1' : null,
    }),
    encode: (ctx) => [
      node('scripts/F-legacy-recovery-encode.mjs', ['--run', join(ctx.runDir, 'F-legacy-recovery', 'footage'), '--font', ctx.font]),
    ],
  },
  {
    id: 'H-firefox',
    step: '13',
    area: 'H-cross-browser-desktop',
    title: 'Cross-browser: Firefox and Firefox with RFP prefs on the staged Firefox zip, Chromium on the Chrome zip',
    kind: 'commands',
    commands: (ctx) => [
      node('tests/live/h-firefox.live.mjs', [
        '--wallet-file', ctx.walletFile,
        '--staged', ctx.stagedDir,
        '--out', join(ctx.runDir, 'H-cross-browser-desktop', 'footage'),
        '--lanes', 'firefox,firefox-rfp,chromium',
        '--font', ctx.font,
      ]),
    ],
    env: () => ({}),
    encode: () => [],
  },
  {
    id: 'H-macos',
    step: '13',
    area: 'H-cross-browser-desktop',
    title: 'macOS desktop smoke: the notarized disk image, isolated app data, compared with a fresh Chromium read',
    kind: 'commands',
    host: 'darwin',
    commands: (ctx) => [
      // The desktop comparison refuses a balance reference older than 30 minutes.
      node('tests/live/h-firefox.live.mjs', [
        '--wallet-file', ctx.walletFile,
        '--staged', ctx.stagedDir,
        '--out', join(ctx.runDir, 'H-cross-browser-desktop', 'footage'),
        '--lanes', 'chromium',
        '--font', ctx.font,
      ]),
      {
        label: 'desktop-smoke-macos.sh',
        command: 'bash',
        args: [
          join(E2E_ROOT, 'scripts', 'desktop-smoke-macos.sh'),
          '--wallet-file', ctx.walletFile,
          '--dmg', join(ctx.stagedDir, 'macos', `Smirk-Wallet-${RELEASE.version}.dmg`),
          '--out-root', join(ctx.runDir, 'H-cross-browser-desktop'),
          '--font', ctx.font,
        ],
      },
    ],
    env: () => ({}),
    encode: () => [],
  },
  {
    id: 'closeout',
    step: '14',
    area: 'closeout',
    title: 'Close out: every final balance of alice, bob and carol held 25 s, for reconciliation against the baseline',
    kind: 'playwright',
    config: 'B-send-receive-history.live.config.ts',
    grep: 'USD in every coin header',
    env: (ctx) => bLaneEnv(ctx, join(ctx.runDir, 'closeout')),
    encode: (ctx) => [bEncode(ctx, join(ctx.runDir, 'closeout'))],
  },
]);

function bLaneEnv(ctx, runDir) {
  return {
    E2E_LIVE_RUN_DIR: runDir,
    E2E_LIVE_RUN_LABEL: ctx.runId,
    E2E_LIVE_EXTENSION_ZIP: ctx.chromeZip,
    E2E_LIVE_EXTENSION_SHA256: RELEASE.chromeSha256,
    E2E_LIVE_WALLET_FILE: ctx.walletFile,
    E2E_MIN_EXECUTED: 'selected',
  };
}

function bEncode(ctx, runDir) {
  return node('scripts/B-send-receive-history-footage.mjs', ['--run', runDir, '--font', ctx.font]);
}

/** The gaps acknowledged for this run: the operator's own, plus federation when the owner declined backend B. */
function ackGaps(ctx) {
  const gaps = new Set((ctx.env.E2E_LIVE_ACK_GAPS ?? '').split(',').map((g) => g.trim()).filter(Boolean));
  if (!ctx.decisions.federationB) gaps.add('federation');
  return gaps.size ? [...gaps].join(',') : null;
}

function node(script, args) {
  return { label: script.split('/').pop(), command: process.execPath, args: [join(E2E_ROOT, script), ...args] };
}

/**
 * G's recorder names each run directory by its start, 20261010T132009Z
 * (fixtures/G-premium-footage.ts). The ones this attempt made, oldest first.
 */
export function newDirs(root, since) {
  if (!existsSync(root)) return [];
  const floor = new Date(since - 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{8}T\d{6}Z$/.test(d.name) && d.name >= floor)
    .map((d) => join(root, d.name))
    .sort();
}

// ── Pure checks (scripts/live-v031.test.mjs) ─────────────────────────────────

export class Refusal extends Error {}

/** Command-line options. Unknown flags refuse. */
export function parseArgs(argv) {
  const options = { list: false, resume: false, keepGoing: false, preflightOnly: false, runDir: null, from: null, only: null, except: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Refusal(`${arg} needs a value`);
      return next;
    };
    if (arg === '--list') options.list = true;
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--keep-going') options.keepGoing = true;
    else if (arg === '--preflight-only') options.preflightOnly = true;
    else if (arg === '--run-dir') options.runDir = resolve(value());
    else if (arg === '--from') options.from = value();
    else if (arg === '--only') options.only = value().split(',').map((p) => p.trim()).filter(Boolean);
    else if (arg === '--except') options.except = value().split(',').map((p) => p.trim()).filter(Boolean);
    else throw new Refusal(`unknown argument ${arg}; see the header of scripts/live-v031.mjs`);
  }
  return options;
}

/**
 * The phases this invocation runs, in order. Names the phase at fault. A
 * phase bound to another host refuses unless excluded explicitly; `host` null
 * (for --list) only plans.
 */
export function planPhases(options, host = platform()) {
  const ids = PHASES.map((p) => p.id);
  for (const id of [...(options.only ?? []), ...options.except, ...(options.from ? [options.from] : [])]) {
    if (!ids.includes(id)) throw new Refusal(`no phase named ${id}; phases: ${ids.join(', ')}`);
  }
  let phases = [...PHASES];
  if (options.from) phases = phases.slice(ids.indexOf(options.from));
  if (options.only) phases = phases.filter((p) => options.only.includes(p.id));
  phases = phases.filter((p) => !options.except.includes(p.id));
  const elsewhere = host === null ? [] : phases.filter((p) => p.host && p.host !== host);
  if (elsewhere.length) {
    throw new Refusal(
      `${elsewhere.map((p) => p.id).join(', ')} runs only on ${elsewhere[0].host}; here, pass --except ${elsewhere.map((p) => p.id).join(',')} and run it on that host with --only`,
    );
  }
  return phases;
}

/** The owner's answers, or the list of decisions without one. Values are yes or no, nothing else. */
export function readDecisions(env) {
  const decisions = {};
  const problems = [];
  for (const { env: name, key, what } of DECISIONS) {
    const value = (env[name] ?? '').trim().toLowerCase();
    if (value === 'yes') decisions[key] = true;
    else if (value === 'no') decisions[key] = false;
    else problems.push(`${name} must be yes or no: the owner's decision on ${what}${value ? ` (it is set to something else)` : ' has not been given'}`);
  }
  return { decisions, problems };
}

/** What the decisions require of the environment: the values each "yes" needs. */
export function decisionProblems(decisions, env) {
  const problems = [];
  if (decisions.federationB && !(env.FED_BACKEND_URL ?? '').trim()) {
    problems.push('V031_FEDERATION_B=yes needs FED_BACKEND_URL, the independent backend B');
  }
  if (decisions.premiumPurchase && !(env.G_PREMIUM_CHECKOUT_HOST ?? '').trim()) {
    problems.push("V031_PREMIUM_PURCHASE=yes needs G_PREMIUM_CHECKOUT_HOST, the owner's BTCPay host; G pays nowhere else");
  }
  return problems;
}

/** Gates that are not open, and switches that would weaken the recording. */
export function gateProblems(env) {
  const problems = [];
  for (const [name, expected] of Object.entries(REQUIRED_GATES)) {
    if ((env[name] ?? '').trim() !== expected) problems.push(`${name}=${expected} is required for the release run`);
  }
  if (!(env.E2E_WALLET_FILE ?? '').trim()) problems.push('E2E_WALLET_FILE must name the owner-only custody file (a path, never a phrase)');
  if ((env.FOOTAGE_ENCODE ?? '').trim() === '0') problems.push('FOOTAGE_ENCODE=0 would leave area A unencoded; the run is recorded and encoded');
  if ((env.E2E_LIVE_HOLDS ?? '').trim()) problems.push('E2E_LIVE_HOLDS shortens holds; the run keeps the full video policy');
  if ((env.HEADED ?? '').trim() && env.HEADED !== '0') problems.push('HEADED shows the unrecorded phrase import to any screen recorder; the run is headless');
  if (env.DEBUG || env.PWDEBUG) problems.push('DEBUG and PWDEBUG can print browser call logs, which may hold secrets');
  return problems;
}

/** Names of variables that look like they carry wallet secret material. Never the values. */
export function secretEnvProblems(env) {
  return Object.entries(env)
    .filter(([name, value]) => /MNEMONIC|SEED|PHRASE|NSEC|PRIVATE_?KEY|SPEND_?KEY|VIEW_?KEY|WALLET_?PASSWORD/i.test(name) && (value ?? '').trim())
    .map(([name]) => `${name} is set in the environment; phrases and keys never travel in variables (the lanes read the custody file in-process)`);
}

/** The environment for the offline guard suites: no gate, decision or lane state of the run leaks into them. */
export function offlineEnv(env) {
  const out = { ...env };
  for (const name of [...Object.keys(REQUIRED_GATES), ...LANE_OWNED, ...DECISIONS.map((d) => d.env), 'E2E_WALLET_FILE']) delete out[name];
  return out;
}

/** Custody file shape: a regular 0600 file of this user with exactly one line per demo wallet. Reads no value out. */
export function custodyProblems(file) {
  if (!existsSync(file)) return ['the custody file named by E2E_WALLET_FILE does not exist on this host'];
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) return ['the custody file must be a regular file, not a link'];
  if ((info.mode & 0o077) !== 0) return ['the custody file must be owner-only (mode 0600)'];
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return ['the custody file must be owned by this user'];
  const lines = readFileSync(file, 'utf8').split('\n');
  const problems = [];
  for (const variable of WALLET_VARIABLES) {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=`);
    const count = lines.filter((line) => pattern.test(line)).length;
    if (count !== 1) problems.push(`the custody file has ${count === 0 ? 'no' : 'more than one'} ${variable} line`);
  }
  lines.fill('');
  return problems;
}

/**
 * The environment a phase runs with: the operator's, minus lane-owned state,
 * plus the phase's overrides (null removes a variable).
 */
export function phaseEnv(phase, ctx, base = process.env) {
  const env = { ...base };
  for (const name of LANE_OWNED) delete env[name];
  env.BACKEND_URL = ctx.backend;
  env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
  for (const [name, value] of Object.entries(phase.env(ctx))) {
    if (value === null || value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** The commands a phase runs (the lane, then its encoders). */
export function phaseCommands(phase, ctx) {
  if (phase.kind === 'commands') return phase.commands(ctx);
  const args = [playwrightCli(), 'test', '-c', join(E2E_ROOT, phase.config)];
  if (phase.grep) args.push('--grep', phase.grep);
  const invert = typeof phase.grepInvert === 'function' ? phase.grepInvert(ctx) : phase.grepInvert;
  if (invert) args.push('--grep-invert', invert);
  return [{ label: phase.config, command: process.execPath, args }];
}

function playwrightCli() {
  try {
    return createRequire(import.meta.url).resolve('@playwright/test/cli');
  } catch {
    return '@playwright/test/cli (not installed; run npm ci first)';
  }
}

// ── Effects ──────────────────────────────────────────────────────────────────

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writePrivate(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function say(line) {
  process.stdout.write(`[v031] ${line}\n`);
}

function sourceState() {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: E2E_ROOT, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: E2E_ROOT, encoding: 'utf8' });
  return {
    commit: commit.status === 0 ? commit.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

function has(tool, args = ['-version']) {
  return spawnSync(tool, args, { stdio: 'ignore' }).status === 0;
}

/** Fetch JSON from the backend; a failure is reported, never treated as "fine". */
async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Refusal(`${url} answered HTTP ${res.status}`);
  return res.json();
}

/** Step 0. Every refusal names its cause; cheap ones run before expensive ones. */
async function preflight(options, phases, env) {
  const problems = [
    ...secretEnvProblems(env),
    ...gateProblems(env),
  ];
  const { decisions, problems: undecided } = readDecisions(env);
  problems.push(...undecided);
  if (!undecided.length) problems.push(...decisionProblems(decisions, env));
  if (problems.length) throw new Refusal(`the run cannot start:\n  - ${problems.join('\n  - ')}`);

  const walletFile = resolve(env.E2E_WALLET_FILE);
  const custody = custodyProblems(walletFile);
  if (custody.length) throw new Refusal(`custody: ${custody.join('; ')}`);

  const font = env.V031_FONT ?? FONTS.find((f) => existsSync(f));
  if (!font || !existsSync(font)) throw new Refusal('no caption font found for the encoders; set V031_FONT to a TTF');
  for (const tool of ['ffmpeg', 'unzip']) if (!has(tool, tool === 'unzip' ? ['-v'] : ['-version'])) throw new Refusal(`${tool} is not on PATH`);
  if (phases.some((p) => p.id === 'H-firefox')) {
    if (!has('firefox', ['--version'])) throw new Refusal('H-firefox needs Firefox 156 on PATH (or pass --except H-firefox and run it where it is)');
    if (!has('geckodriver', ['--version'])) throw new Refusal('H-firefox needs geckodriver 0.37.1 on PATH');
  }

  const runDir = options.runDir ?? join(RUN_ROOT, new Date().toISOString().slice(0, 10));
  if (existsSync(join(runDir, 'run.json')) && !options.resume) {
    throw new Refusal(`${runDir} already holds a run; pass --resume to continue it, or --run-dir for a new one`);
  }
  if (options.resume && !existsSync(join(runDir, 'run.json'))) throw new Refusal(`--resume: ${runDir} holds no run to continue`);
  privateDir(runDir);
  const free = (() => {
    const s = statfsSync(runDir);
    return Number(s.bavail) * Number(s.bsize);
  })();
  if (free < MIN_FREE_BYTES) throw new Refusal(`only ${(free / 1024 ** 3).toFixed(1)} GB free under ${runDir}; the run needs 20 GB`);

  const stagedDir = resolve(env.V031_STAGED_DIR ?? RELEASE.stagedDir);
  const chromeZip = join(stagedDir, RELEASE.chromeZip);
  const firefoxZip = join(stagedDir, RELEASE.firefoxZip);
  for (const [zip, expected] of [[chromeZip, RELEASE.chromeSha256], [firefoxZip, RELEASE.firefoxSha256]]) {
    if (!existsSync(zip)) throw new Refusal(`the staged zip ${zip} is missing; set V031_STAGED_DIR`);
    const actual = await sha256(zip);
    if (actual !== expected) throw new Refusal(`${RELEASE.chromeZip === zip.split('/').pop() ? 'Chrome' : 'Firefox'} zip hashes to ${actual}, not the release candidate's ${expected}`);
  }
  say(`release candidate ${RELEASE.version} (run ${RELEASE.run}, source ${RELEASE.sourceCommit}): both staged zips match their pinned SHA-256`);

  const chromeDir = join(privateDir(join(runDir, 'release')), 'chrome');
  rmSync(chromeDir, { recursive: true, force: true });
  privateDir(chromeDir);
  if (spawnSync('unzip', ['-q', chromeZip, '-d', chromeDir], { stdio: 'ignore' }).status !== 0) throw new Refusal('unzip could not unpack the staged Chrome zip');
  const manifest = JSON.parse(readFileSync(join(chromeDir, 'manifest.json'), 'utf8'));
  if (manifest.version !== RELEASE.version) throw new Refusal(`the unpacked Chrome zip is version ${manifest.version}, not ${RELEASE.version}`);

  const backend = (env.BACKEND_URL ?? PRODUCTION_BACKEND).replace(/\/$/, '');
  const preflightDir = privateDir(join(runDir, 'preflight'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let caps;
  try {
    caps = await getJson(`${backend}/capabilities`);
    writePrivate(join(preflightDir, `${stamp}-capabilities.json`), JSON.stringify(caps, null, 1));
    writePrivate(join(preflightDir, `${stamp}-prices.json`), JSON.stringify(await getJson(`${backend}/prices`), null, 1));
  } catch (error) {
    throw new Refusal(`the backend snapshot failed, so nothing is known about what this run would exercise: ${error.message}`);
  }
  const f = caps.features ?? {};
  say(`backend ${backend}: version ${caps.version ?? 'unknown'}`);
  say(`  pow_required ${caps.registration?.pow_required}; legacy_merge_v2 ${f.legacy_merge_v2}; tips ${f.tips}; nostr_relay ${f.nostr_relay}; feed ${f.feed}`);
  say(`  thorchain ${JSON.stringify(caps.swaps?.thorchain ?? null)}; nonlogs ${JSON.stringify(caps.swaps?.nonlogs ?? null)}`);
  say(`  premium rails ${JSON.stringify(caps.premium?.rails ?? null)}; relay ${caps.messaging?.relay_url ?? 'none'} (${caps.messaging?.write_policy ?? 'no policy'})`);

  // Every lane's offline guards (recorder dry runs on sentinel pages included) and the privacy regression.
  for (const script of ['test:live-v031-guards', 'test:privacy']) {
    say(`offline: npm run ${script}`);
    const run = spawnSync('npm', ['run', script], { cwd: E2E_ROOT, stdio: 'inherit', env: offlineEnv(env) });
    if (run.status !== 0) throw new Refusal(`npm run ${script} failed; the recorders and guards are not proven, so nothing is recorded`);
  }

  const source = sourceState();
  const runId = `v031-${runDir.split('/').pop()}`;
  // A preflight-only pass records nothing a later run would have to --resume.
  if (!options.resume && !options.preflightOnly) {
    writePrivate(join(runDir, 'run.json'), JSON.stringify({
      format: 'smirk-e2e-v031-run/1',
      runId,
      createdAt: new Date().toISOString(),
      host: hostname(),
      platform: platform(),
      release: { ...RELEASE, stagedDir },
      testSource: source,
      backend,
      decisions,
      plan: phases.map((p) => p.id),
    }, null, 1));
  }
  say(`run ${runId} in ${runDir}; test source ${source.commit ?? 'unknown'}${source.dirty ? ' with local changes' : ''}`);
  say(`owner decisions: ${DECISIONS.map((d) => `${d.env}=${decisions[d.key] ? 'yes' : 'no'}`).join(' ')}`);
  if (!decisions.federationB) say('federation gap acknowledged by the owner: C and D list those skips as chosen, never as evidence');
  if (RELEASE.sourceCommit === '14a74e10' && !(env.E_SWAPS_ACCEPT_KNOWN_ISSUES ?? '').includes('stale-provider-note')) {
    say("note: on 14a74e10 E's 'live provider card drops its pre-check note' fails by design unless the owner sets E_SWAPS_ACCEPT_KNOWN_ISSUES=stale-provider-note");
  }
  return { runDir, runId, walletFile, backend, stagedDir, chromeZip, firefoxZip, chromeDir, decisions, font, env };
}

/**
 * Ctrl-C reaches the lane too (one process group). The lane must be allowed to
 * finish its own cleanup (C keeps unsettled profiles and writes RECOVERY.md;
 * H kills its browsers), so the runner only notes the interrupt, waits for the
 * lane to exit, and starts nothing after it.
 */
let interrupted = false;
function onInterrupt(signal) {
  if (!interrupted) say(`${signal}: letting the running lane stop and clean up; no further phase starts`);
  interrupted = true;
}

function readStatus(runDir, id) {
  const file = join(runDir, 'phases', `${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { id, status: 'pending', attempts: [] };
}

function writeStatus(runDir, status) {
  writePrivate(join(privateDir(join(runDir, 'phases')), `${status.id}.json`), JSON.stringify(status, null, 1));
}

/** Run one command, its output to the terminal and the phase log. Resolves with the exit code. */
function runLogged(cmd, env, log) {
  return new Promise((done) => {
    log.write(`\n# ${cmd.label}\n`);
    const child = spawn(cmd.command, cmd.args, { cwd: E2E_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk); log.write(chunk); });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); log.write(chunk); });
    child.on('error', () => done(127));
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

async function runPhase(phase, ctx) {
  const status = readStatus(ctx.runDir, phase.id);
  const attempt = status.attempts.length + 1;
  const startedAt = Date.now();
  const phaseCtx = { ...ctx, attemptId: `${startedAt}`, attemptStartedAt: startedAt };
  const env = phaseEnv(phase, phaseCtx);
  const logPath = join(privateDir(join(ctx.runDir, 'logs')), `${phase.id}-${attempt}.log`);
  // The private reporter's failure explanations (classes, step labels, screen
  // test ids, request shapes, recoveries; never values), beside the phase log.
  env.E2E_PRIVATE_LOG = join(ctx.runDir, 'logs', `${phase.id}-${attempt}.private.jsonl`);
  const log = createWriteStream(logPath, { mode: 0o600 });
  const record = { attempt, startedAt: new Date(startedAt).toISOString(), decisions: ctx.decisions, commands: [], log: logPath };
  status.status = 'running';
  status.step = phase.step;
  status.title = phase.title;
  status.attempts.push(record);
  writeStatus(ctx.runDir, status);

  say(`── step ${phase.step}: ${phase.id}, ${phase.title} (attempt ${attempt})`);
  let ok = true;
  for (const cmd of phaseCommands(phase, phaseCtx)) {
    const code = await runLogged(cmd, env, log);
    record.commands.push({ label: cmd.label, exit: code });
    if (code !== 0) ok = false;
    if ((code !== 0 && phase.kind === 'commands') || interrupted) break;
  }
  // Footage is encoded even after a failed lane: what was recorded is evidence,
  // and each encoder refuses a hold shorter than the owner's policy. Not after
  // an interrupt: the operator asked to stop.
  for (const cmd of interrupted ? [] : phase.encode(phaseCtx)) {
    const code = await runLogged(cmd, env, log);
    record.commands.push({ label: `encode ${cmd.label}`, exit: code });
    if (code !== 0) ok = false;
  }
  await new Promise((done) => log.end(done));
  chmodSync(logPath, 0o600);
  record.endedAt = new Date().toISOString();
  status.status = interrupted ? 'interrupted' : ok ? 'passed' : 'failed';
  writeStatus(ctx.runDir, status);
  say(`── ${phase.id}: ${status.status} (${Math.round((Date.now() - startedAt) / 60_000)} min)`);
  return ok && !interrupted;
}

function summarize(ctx, phases) {
  const rows = PHASES.map((p) => {
    const s = readStatus(ctx.runDir, p.id);
    return { id: p.id, step: p.step, status: phases.includes(p) ? s.status : s.status === 'pending' ? 'not in this invocation' : s.status, attempts: s.attempts.length, area: join(ctx.runDir, p.area) };
  });
  writePrivate(join(ctx.runDir, 'summary.json'), JSON.stringify({ runDir: ctx.runDir, at: new Date().toISOString(), phases: rows }, null, 1));
  say('summary:');
  for (const r of rows) say(`  ${r.id.padEnd(10)} step ${r.step.padEnd(18)} ${r.status}${r.attempts > 1 ? ` (${r.attempts} attempts)` : ''}`);
  say('step 14 by hand: reconcile closeout against baseline minus fees, swap spread and the premium payment, from');
  say("  B's spend ledger, C's C-tips-state/ledger.json, E's evidence.json and in-flight ledger, G's evidence.json;");
  say('  then write the evidence note to ~/journal/ops/handoffs/smirk/ and keep the video here, under ~/Build.');
  return rows.every((r) => r.status === 'passed' || r.status === 'not in this invocation');
}

function printPlan(phases) {
  say('step 0   preflight   release hashes and unpack, capabilities and prices, offline guards, privacy, disk, custody, decisions');
  for (const p of phases) {
    const how = p.kind === 'playwright' ? `-c ${p.config}${p.grep ? ` --grep "${p.grep}"` : ''}` : 'node/bash commands';
    say(`step ${p.step.padEnd(14)} ${p.id.padEnd(10)} ${p.title}\n         ${how}${p.host ? ` (host: ${p.host})` : ''}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const phases = planPhases(options, options.list ? null : platform());
  if (options.list) {
    printPlan(phases);
    return 0;
  }
  const ctx = await preflight(options, phases, process.env);
  if (options.preflightOnly) {
    say('preflight passed; no lane started (--preflight-only)');
    return 0;
  }
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  for (const phase of phases) {
    if (interrupted) break;
    if (options.resume && readStatus(ctx.runDir, phase.id).status === 'passed') {
      say(`── ${phase.id}: passed in an earlier attempt; not run again`);
      continue;
    }
    const ok = await runPhase(phase, ctx);
    if (interrupted) break;
    if (!ok && !options.keepGoing) {
      say(`stopped after ${phase.id} failed; fix the cause, then --resume (or --keep-going to run on past a failure)`);
      break;
    }
  }
  return summarize(ctx, phases) ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      if (error instanceof Refusal) {
        process.stderr.write(`[v031] refused: ${error.message}\n`);
        process.exit(2);
      }
      // Our own failures only; lane output went to the terminal and the log.
      process.stderr.write(`[v031] runner error: ${error?.name ?? 'Error'}: ${String(error?.message ?? '').split('\n')[0]}\n`);
      process.exit(1);
    },
  );
}
