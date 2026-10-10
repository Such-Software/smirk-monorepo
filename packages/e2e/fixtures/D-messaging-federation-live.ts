/**
 * Live lane fixture for area D (messaging and federation): alice, bob and carol
 * loaded once per worker into three persistent Chromium profiles of the
 * UNPACKED RELEASE ARTIFACT, each recorded by its own guarded footage recorder.
 *
 * Gates, each its own explicit opt-in (see `dLiveSkipReason`):
 *   - `E2E_LIVE=1`         this lane runs at all.
 *   - `BACKEND_URL`        the backend the release build targets (production
 *                          for the v0.3.1 run); global setup proves the bundle
 *                          was built against it.
 *   - `EXTENSION_DIST`     the unpacked, hash-verified release zip.
 *   - `E2E_WALLET_FILE`    the owner-only custody file (default: the main
 *                          checkout's packages/smoke-tests/secrets path).
 *   - `E2E_LIVE_RELAY=1`   publishing to the production relay (specs check it).
 *   - `FOOTAGE=guarded`    recording; `E2E_FOOTAGE_DIR` overrides the output.
 *
 * Custody: each phrase is read in-process by the demo lane's reviewed
 * `readWalletPhrase` (one NAME=value line, regular 0600 file owned by this
 * user, 12 or 24 lowercase words). It is never placed in the environment, so no
 * child process (the browsers included) inherits it, and browsers launch with
 * secret-looking variables scrubbed. Each wallet gets a random in-memory
 * password. After import the word arrays are zeroed; only the canary's
 * shingle digests and the account-0 PUBLIC key remain. Profiles live under a
 * 0700 scratch directory and are deleted at teardown.
 *
 * Nothing here prints a phrase, password, key or page text. A failed import
 * reports its stage only, never the underlying message.
 *
 * Relay guard: every WebSocket a wallet page opens goes through
 * `context.routeWebSocket`. An outbound EVENT frame is forwarded only when
 * `liveRelayAdmits` (fixtures/relay-guard.ts) admits its kind for that relay;
 * anything else is answered with a relay-style refusal and counted. The fixture
 * proves the route is attached before any test runs (fails closed).
 */

import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveNostrIdentity } from '@smirk/core';
import { test as privateTest } from './private-test.js';
import { isLocalPublishRelay, liveRelayAdmits } from './relay-guard.js';
import {
  DFootage,
  SecretCanary,
  assertHoldsMeetPolicy,
  footageEnabled,
  holdsShortened,
  loadGuard,
} from './D-messaging-federation-footage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DWalletName = 'alice' | 'bob' | 'carol';
export const D_WALLET_NAMES: readonly DWalletName[] = ['alice', 'bob', 'carol'];

/** Popup-sized viewport at device pixels, as the demo lane records. */
const VIEWPORT = { width: 380, height: 600 };
const SCALE = 2;

/** Backend under test (required for the live lane; global setup checks the bundle). */
export const D_BACKEND_URL = process.env.BACKEND_URL ?? '';

/** Unpacked release artifact. */
export const D_EXTENSION_DIST = process.env.EXTENSION_DIST ?? '';

/** Owner-only custody file holding SMOKE_<NAME>_MNEMONIC lines. */
export const D_WALLET_FILE = resolve(
  process.env.E2E_WALLET_FILE ?? join(__dirname, '..', '..', 'smoke-tests', 'secrets', 'smoke-mnemonics.env'),
);

/** Relay guard bookkeeping per wallet context: counts and kinds, never content. */
export interface DRelayGuard {
  /** WebSockets the route saw (the attach proof). */
  connections: number;
  /** Relay hosts the page opened, with when (public operator hosts only). */
  opened: { host: string; at: number }[];
  /** Outbound events forwarded, by kind. */
  forwarded: Record<number, number>;
  /** Outbound events refused, with the static rule that refused them. */
  blocked: { kind: number; reason: string }[];
  /** Set by the feed test only after the server granted posting rights and the
   *  owner approved a public note (E2E_LIVE_FEED_POST=1). */
  notePostingVerified: boolean;
}

export interface DWallet {
  name: DWalletName;
  context: BrowserContext;
  page: Page;
  extensionId: string;
  /** Seed account-0 identity (public). Checked against the UI by the specs. */
  npub: string;
  pubkeyHex: string;
  footage: DFootage;
  relayGuard: DRelayGuard;
  /**
   * Whether the account is linked to this seed npub, as the identity hub shows
   * it (null until read). The operator relay admits gift wraps only to linked
   * npubs, so an unlinked wallet cannot receive DMs there.
   */
  linked: boolean | null;
  /** Unlock from the lock screen inside a redaction scope (no-op when unlocked). */
  unlock(): Promise<void>;
  /** Confirm an operation-password prompt inside a redaction scope. */
  confirmOperationPassword(): Promise<void>;
}

export interface DWallets {
  alice: DWallet;
  bob: DWallet;
  carol: DWallet;
  all: readonly DWallet[];
  /** Chapter marker on every recorder (static label). */
  chapter(label: string): void;
  /** Register a Node-side secret (a test key) with the footage canary. */
  watchSecret(value: string): void;
  /** True when `text` contains a known secret (canary match). */
  carriesSecret(text: string): boolean;
}

/**
 * Why this lane cannot run here, or null. Call at file level so a skipped run
 * never instantiates the wallets.
 */
export function dLiveSkipReason(): string | null {
  if (process.env.E2E_LIVE !== '1') {
    return 'live lane: set E2E_LIVE=1 (and BACKEND_URL, EXTENSION_DIST, E2E_WALLET_FILE) to run against real services';
  }
  if (!D_BACKEND_URL) return 'live lane: BACKEND_URL must name the backend the release build targets';
  if (!D_EXTENSION_DIST || !existsSync(join(D_EXTENSION_DIST, 'manifest.json'))) {
    return 'live lane: EXTENSION_DIST must point at the unpacked release artifact';
  }
  if (!existsSync(D_WALLET_FILE)) {
    return 'live lane: the wallet custody file is not on this host (set E2E_WALLET_FILE to the owner-only file in the main checkout)';
  }
  return null;
}

/**
 * Why a relay-publishing test cannot run here, or null. A loopback backend's
 * relay is a disposable local one; anything else is production and needs the
 * explicit `E2E_LIVE_RELAY=1` (which admits only kinds 1059 and 10050).
 */
export function dRelaySkipReason(): string | null {
  let host = '';
  try {
    host = new URL(D_BACKEND_URL).hostname;
  } catch {
    // Unparseable: treated as production below.
  }
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') return null;
  return process.env.E2E_LIVE_RELAY === '1'
    ? null
    : 'live lane: these tests publish NIP-17 gift wraps to the production relay; set E2E_LIVE_RELAY=1 to admit kinds 1059 and 10050';
}

/**
 * Whether the owner approved linking a demo wallet's seed npub to its own
 * account during the run (`E2E_LIVE_LINK=1`, with `ALLOW_PROD_WRITES=1`). It is
 * a durable production account write, so it is never inferred.
 */
export function dLinkApproved(): boolean {
  return process.env.E2E_LIVE_LINK === '1' && process.env.ALLOW_PROD_WRITES === '1';
}

/** Version of the artifact under test (from its manifest). */
export function dExtensionVersion(): string {
  const manifest = JSON.parse(readFileSync(join(D_EXTENSION_DIST, 'manifest.json'), 'utf8')) as { version?: string };
  return manifest.version ?? 'unknown';
}

/**
 * This worker's footage directory:
 * ~/Build/smirk-e2e/v<version>-<label>/footage/raw/D-messaging-federation/<run stamp>/segment-<ms>.
 * One run stamp per Playwright run (kept in the run directory), one segment per
 * worker, so a worker restarted after a failure never overwrites earlier frames.
 * The encoder joins the segments in order.
 */
function footageRoot(runDir: string): string {
  const stampFile = join(runDir, 'footage-stamp');
  if (!existsSync(stampFile)) writeFileSync(stampFile, new Date().toISOString().replace(/[:.]/g, '-'), { mode: 0o600 });
  const stamp = readFileSync(stampFile, 'utf8').trim();
  const label = (process.env.E2E_RUN_LABEL ?? 'run').replace(/[^A-Za-z0-9._-]/g, '');
  const runRoot = process.env.E2E_FOOTAGE_DIR
    ? resolve(process.env.E2E_FOOTAGE_DIR)
    : join(homedir(), 'Build', 'smirk-e2e', `v${dExtensionVersion()}-${label}`, 'footage', 'raw', 'D-messaging-federation', stamp);
  const root = join(runRoot, `segment-${Date.now()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(runRoot, 0o700);
  chmodSync(root, 0o700);
  return root;
}

/**
 * Record a finding: an honest outcome that is not a failure but must reach the
 * owner (a scenario the deployment cannot exercise, a policy that refuses by
 * design). Static descriptions only. The private reporter prints statuses
 * alone, so findings also go to a 0600 JSON-lines file beside the footage:
 * ~/Build/smirk-e2e/v<version>-<label>/reports/D-messaging-federation-findings.jsonl
 */
export function recordFinding(type: string, description: string): void {
  const info = test.info();
  info.annotations.push({ type, description });
  appendFinding(info.title, type, description);
}

function appendFinding(title: string, type: string, description: string): void {
  const label = (process.env.E2E_RUN_LABEL ?? 'run').replace(/[^A-Za-z0-9._-]/g, '');
  const dir = join(homedir(), 'Build', 'smirk-e2e', `v${dExtensionVersion()}-${label}`, 'reports');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ at: new Date().toISOString(), test: title, type, description });
  appendFileSync(join(dir, 'D-messaging-federation-findings.jsonl'), `${line}\n`, { mode: 0o600 });
}

/** Browser environment without anything that looks like a credential. */
function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/MNEMONIC|SEED|PASSWORD|PASSPHRASE|SECRET|TOKEN|PRIVATE|NSEC|API_KEY|CREDENTIAL/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

type ReadWalletPhrase = (file: string, variable: string) => string[];

/** The reviewed custody reader from the demo lane (one implementation, not two). */
async function loadCustody(): Promise<ReadWalletPhrase> {
  const href = new URL('../demo/capture-demo.mjs', import.meta.url).href;
  const mod = (await import(href)) as { readWalletPhrase?: ReadWalletPhrase };
  if (typeof mod.readWalletPhrase !== 'function') throw new Error('custody reader did not load');
  return mod.readWalletPhrase;
}

/** Parse an outbound relay frame: the kind of an EVENT, or null for anything else. */
function outboundEvent(message: string | Buffer): { id: string; kind: number } | null {
  if (typeof message !== 'string') return null;
  try {
    const frame = JSON.parse(message) as unknown;
    if (!Array.isArray(frame) || frame[0] !== 'EVENT') return null;
    const event = frame[1] as { id?: unknown; kind?: unknown } | undefined;
    if (!event || typeof event.kind !== 'number') return { id: '', kind: -1 };
    return { id: typeof event.id === 'string' ? event.id : '', kind: event.kind };
  } catch {
    return null;
  }
}

async function installRelayGuard(context: BrowserContext): Promise<DRelayGuard> {
  const state: DRelayGuard = { connections: 0, opened: [], forwarded: {}, blocked: [], notePostingVerified: false };
  await context.routeWebSocket(/^wss?:\/\//, (ws) => {
    state.connections++;
    const url = ws.url();
    try {
      state.opened.push({ host: new URL(url).host, at: Date.now() });
    } catch {
      state.opened.push({ host: 'unparseable', at: Date.now() });
    }
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      // Nostr is text. A binary frame to a production relay is not something
      // the wallet sends, so it is dropped rather than inspected.
      if (typeof message !== 'string' && !isLocalPublishRelay(url)) {
        state.blocked.push({ kind: -1, reason: 'binary frame to a production relay' });
        return;
      }
      const event = outboundEvent(message);
      if (event) {
        const decision = liveRelayAdmits(url, event.kind, { premium: state.notePostingVerified });
        if (!decision.admit) {
          state.blocked.push({ kind: event.kind, reason: decision.reason });
          ws.send(JSON.stringify(['OK', event.id, false, 'blocked: e2e relay guard refused this kind']));
          return;
        }
        state.forwarded[event.kind] = (state.forwarded[event.kind] ?? 0) + 1;
      }
      server.send(message);
    });
  });
  return state;
}

/** Prove the route is attached: a REQ-only socket from the page must be seen. */
async function assertRelayGuardAttached(page: Page, guard: DRelayGuard): Promise<void> {
  let relayUrl: string | undefined;
  try {
    const caps = (await (await fetch(`${D_BACKEND_URL.replace(/\/$/, '')}/capabilities`)).json()) as {
      messaging?: { relay_url?: string } | null;
    };
    relayUrl = caps.messaging?.relay_url;
  } catch {
    throw new Error('live lane: could not read /capabilities to check the relay guard');
  }
  if (!relayUrl) return; // no relay advertised: nothing to publish to, nothing to guard
  const before = guard.connections;
  const outcome = await page.evaluate(async (url) => {
    return await new Promise<string>((done) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => done('timeout'), 20_000);
      socket.onopen = () => {
        clearTimeout(timer);
        socket.close();
        done('open');
      };
      socket.onerror = () => {
        clearTimeout(timer);
        done('error');
      };
    });
  }, relayUrl);
  if (guard.connections <= before || outcome !== 'open') {
    throw new Error('live lane: the relay guard did not attach to the wallet page; refusing to publish anything');
  }
}

/** Import one wallet (never recorded: this page's earlier screens are not captured). */
async function importIntoProfile(
  context: BrowserContext,
  extensionId: string,
  words: readonly string[],
  password: string,
): Promise<Page> {
  const page = await context.newPage();
  let stage = 'open';
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    stage = 'welcome';
    await page.getByTestId('onboarding-import-btn').click({ timeout: 60_000 });
    await page.getByTestId('onboarding-import-warning-continue').click();
    stage = 'phrase';
    for (let i = 0; i < words.length; i++) await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i]!);
    await page.getByTestId('onboarding-import-continue').click();
    stage = 'password';
    // The wizard fails closed until the backend's sign-up requirements resolve;
    // its retry rebuilds the step with empty fields, so re-enter before each press.
    const submit = page.getByTestId('onboarding-set-password-submit');
    for (let attempt = 0; attempt < 12; attempt++) {
      await page.getByTestId('onboarding-password-input').fill(password);
      await page.getByTestId('onboarding-password-confirm-input').fill(password);
      await submit.click();
      await page.waitForTimeout(3_000);
      if (!(await submit.isVisible().catch(() => false))) break;
      // Retry only what the wallet itself calls retryable: the capabilities
      // race, and a history lookup that did not answer ("Retry before
      // registering"). The backend allows 30 history lookups an hour per IP,
      // shared by every run on this host, so a rate-limited lookup waits a
      // minute for the window to move. Any other refusal stops here.
      const screen = await page.locator('#root').innerText();
      if (!/sign-up requirements|Could not check wallet history/.test(screen)) break;
      const limited = /too many|rate.?limit|429/i.test(screen);
      await page.waitForTimeout(limited ? 60_000 : /wallet history/.test(screen) ? 20_000 : 5_000);
    }
    stage = 'setup';
    await page.getByTestId('onboarding-setup-finish-btn').click({ timeout: 25_000 }).catch(() => {});
    stage = 'home';
    const total = page.getByTestId('home-total-balance');
    await total.waitFor({ timeout: 120_000 });
    await expect.poll(async () => (await total.textContent()) ?? '', { timeout: 120_000 }).toMatch(/\d/);
    return page;
  } catch {
    // Stage only: Playwright call logs can quote values typed into fields.
    // As in the demo lane, name the visible screen by its test IDs, and add
    // its text only when no phrase field is on it. Typed values (the phrase
    // words, the password) live in input values, never in the page text, and
    // the canary still checks the line before it is recorded.
    const ids = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid]'))
          .filter((e) => e.getBoundingClientRect().width > 0)
          .map((e) => (e as HTMLElement).dataset.testid ?? '')
          .slice(0, 30),
      )
      .catch(() => [] as string[]);
    const sensitive = ids.some((id) => /import-word|mnemonic|seed|revealed/i.test(id));
    const text = sensitive
      ? '(withheld on a phrase screen)'
      : ((await page.locator('#root').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(-240);
    throw new Error(`live lane: wallet import stopped at the ${stage} stage; screen: ${ids.join(', ') || 'none'}; text: ${text}`);
  }
}

/** Unlock a profile a previous worker of this run imported (no history lookup). */
async function unlockProfile(context: BrowserContext, extensionId: string, password: string): Promise<Page> {
  const page = await context.newPage();
  let stage = 'open';
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    stage = 'lock screen';
    const input = page.getByTestId('lockscreen-password-input');
    await input.waitFor({ timeout: 60_000 });
    await input.fill(password);
    await page.getByTestId('lockscreen-unlock-btn').click();
    stage = 'home';
    const total = page.getByTestId('home-total-balance');
    await total.waitFor({ timeout: 120_000 });
    await expect.poll(async () => (await total.textContent()) ?? '', { timeout: 120_000 }).toMatch(/\d/);
    return page;
  } catch {
    throw new Error(`live lane: unlocking the run's profile stopped at the ${stage} stage`);
  }
}

/**
 * The run's profile directory, shared by every worker of ONE Playwright run
 * (keyed by the runner's pid). A failed test restarts the worker; reusing the
 * imported profiles then costs an unlock instead of three more history
 * lookups, which the backend limits to 30 an hour per IP for every run on the
 * host. The directory is 0700 and removed by the config's global teardown;
 * directories of runs that no longer exist are removed here.
 */
function runProfileDir(): { dir: string; salt: string } {
  for (const entry of readdirSync(tmpdir())) {
    const match = entry.match(/^smirk-e2e-D-run-(\d+)$/);
    if (!match || Number(match[1]) === process.ppid) continue;
    try {
      process.kill(Number(match[1]), 0);
    } catch {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    }
  }
  const dir = join(tmpdir(), `smirk-e2e-D-run-${process.ppid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const saltFile = join(dir, 'salt');
  if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(16).toString('hex'), { mode: 0o600 });
  return { dir, salt: readFileSync(saltFile, 'utf8').trim() };
}

async function openWallet(
  name: DWalletName,
  deps: {
    readWalletPhrase: ReadWalletPhrase;
    canary: SecretCanary;
    scratch: string;
    salt: string;
    recordRoot: string | null;
    guard: Awaited<ReturnType<typeof loadGuard>>;
    shortHolds: boolean;
  },
): Promise<DWallet> {
  const words = deps.readWalletPhrase(D_WALLET_FILE, `SMOKE_${name.toUpperCase()}_MNEMONIC`);
  // Derived in memory from the phrase and the run's salt, so a restarted
  // worker can unlock the profile this run already imported. Never stored.
  const password = createHmac('sha256', words.join(' ')).update(`smirk-e2e-D|${name}|${deps.salt}`).digest('base64url');
  deps.canary.addPhrase(words);
  deps.canary.addExact(password);
  let npub: string;
  let pubkeyHex: string;
  {
    const identity = deriveNostrIdentity(words.join(' '), 0);
    npub = identity.npub;
    pubkeyHex = identity.pubkeyHex;
    identity.privateKey.fill(0);
  }

  const profile = join(deps.scratch, name);
  const marker = join(deps.scratch, `${name}.imported`);
  const reuse = existsSync(marker) && existsSync(profile);
  // A profile without the marker is a failed import (it may hold a half-set-up
  // wallet that opens on the lock screen): start it clean.
  if (!reuse) rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profile, {
    headless: !process.env.HEADED,
    channel: 'chromium',
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    env: scrubbedEnv(),
    args: [`--disable-extensions-except=${D_EXTENSION_DIST}`, `--load-extension=${D_EXTENSION_DIST}`],
  });
  try {
    // Bound every action: a control that never becomes actionable fails the
    // step instead of waiting out the two-hour test budget.
    context.setDefaultTimeout(90_000);
    context.setDefaultNavigationTimeout(90_000);
    const relayGuard = await installRelayGuard(context);
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(worker.url()).host;
    const page = reuse
      ? await unlockProfile(context, extensionId, password)
      : await importIntoProfile(context, extensionId, words, password);
    words.fill('');
    if (!reuse) writeFileSync(marker, 'imported\n', { mode: 0o600 });
    await assertRelayGuardAttached(page, relayGuard);
    // Dialogs: identity actions use window.confirm; tests accept them
    // explicitly, and anything else is dismissed (Playwright's default).
    const footage = new DFootage(name, page, {
      dir: deps.recordRoot ? join(deps.recordRoot, name) : null,
      canary: deps.canary,
      guard: deps.guard,
      shortHolds: deps.shortHolds,
    });
    const wallet: DWallet = {
      name,
      context,
      page,
      extensionId,
      npub,
      pubkeyHex,
      footage,
      relayGuard,
      linked: null,
      async unlock() {
        const input = page.getByTestId('lockscreen-password-input');
        if (!(await input.isVisible().catch(() => false))) return;
        await footage.secret('unlock the wallet', async () => {
          await input.fill(password);
          await page.getByTestId('lockscreen-unlock-btn').click();
          await page.getByTestId('bottom-nav').waitFor({ timeout: 120_000 });
        });
      },
      async confirmOperationPassword() {
        const input = page.getByTestId('operation-password');
        if (!(await input.isVisible().catch(() => false))) return;
        await footage.secret('confirm with the password', async () => {
          await input.fill(password);
          await page.getByTestId('operation-password-confirm').click();
          await input.waitFor({ state: 'hidden', timeout: 60_000 });
        });
      },
    };
    return wallet;
  } catch (error) {
    words.fill('');
    await context.close().catch(() => {});
    throw error;
  }
}

type DFixtures = { dPacing: void };
type DWorkerFixtures = { dWallets: DWallets };

export const test = privateTest.extend<DFixtures, DWorkerFixtures>({
  dWallets: [
    async ({}, use) => {
      let guard: Awaited<ReturnType<typeof loadGuard>>;
      let readWalletPhrase: ReadWalletPhrase;
      let shortHolds: boolean;
      let recordRoot: string | null;
      try {
        guard = await loadGuard();
        readWalletPhrase = await loadCustody();
        shortHolds = holdsShortened();
        recordRoot = footageEnabled() ? footageRoot(runProfileDir().dir) : null;
        const expected = process.env.E2E_EXPECT_VERSION;
        if (expected && dExtensionVersion() !== expected) {
          throw new Error('live lane: EXTENSION_DIST is not the expected release version');
        }
      } catch (error) {
        // Nothing secret is loaded yet: the first line is safe to record.
        if (process.env.E2E_LIVE_DIAGNOSE === '1') {
          appendFinding('lane setup', 'failure', String(error instanceof Error ? error.message : error).split('\n')[0]!.slice(0, 300));
        }
        throw error;
      }
      const canary = new SecretCanary();
      const { dir: scratch, salt } = runProfileDir();
      const opened: DWallet[] = [];
      try {
        // Sequential: three concurrent restores against one backend would race
        // its sign-up checks for no benefit.
        for (const name of D_WALLET_NAMES) {
          try {
            opened.push(await openWallet(name, { readWalletPhrase, canary, scratch, salt, recordRoot, guard, shortHolds }));
          } catch (error) {
            if (process.env.E2E_LIVE_DIAGNOSE === '1') {
              // The lane's own messages name a stage only; anything else is
              // reduced to its first line and checked against the canary.
              const first = String(error instanceof Error ? error.message : error).split('\n')[0]!.slice(0, 700);
              const safe = first.startsWith('live lane:') || !(canary.hit([first]) || /nsec1|[xtyz]prv/.test(first));
              appendFinding('wallet setup', 'failure', `${name}: ${safe ? first : '(withheld: it carries a secret)'}`);
            }
            throw error;
          }
        }
        // Recording starts only once all three wallets are on Home.
        for (const wallet of opened) wallet.footage.start();
        const [alice, bob, carol] = opened as [DWallet, DWallet, DWallet];
        await use({
          alice,
          bob,
          carol,
          all: opened,
          chapter(label: string) {
            for (const wallet of opened) wallet.footage.mark(label);
          },
          watchSecret(value: string) {
            canary.addExact(value);
          },
          carriesSecret(text: string) {
            return canary.hit([text]);
          },
        });
      } finally {
        for (const wallet of opened) await wallet.footage.stop().catch(() => {});
        // Profiles stay for the next worker of this run; the config's global
        // teardown removes the run directory.
        for (const wallet of opened) await wallet.context.close().catch(() => {});
      }
    },
    { scope: 'worker', timeout: 45 * 60_000 },
  ],

  // After every passing test: every hold met the video policy. A shortened
  // selector-check run (no footage) is exempt by construction.
  //
  // `E2E_LIVE_DIAGNOSE=1` (off by default) records the FIRST LINE of a failure
  // in the findings file, so a long run can be triaged without the withheld
  // reporter output. Assertion messages here are static; Playwright puts
  // values only on later lines. A line that carries a known secret (canary) or
  // key-like text is withheld outright.
  dPacing: [
    async ({ dWallets }, use, testInfo) => {
      await use();
      if (testInfo.status === 'passed' && !holdsShortened()) {
        assertHoldsMeetPolicy(dWallets.all.map((w) => w.footage));
      }
      if (process.env.E2E_LIVE_DIAGNOSE === '1' && testInfo.status !== testInfo.expectedStatus) {
        for (const error of testInfo.errors) {
          const first = (error.message ?? '').split('\n')[0]!.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300);
          const unsafe = dWallets.carriesSecret(first) || /nsec1|[xtyz]prv|tip\/[^\s]*#/.test(first);
          const frame = (error.stack ?? '').match(/([\w.-]+\.(?:spec\.)?ts):(\d+)/);
          const where = frame ? `${frame[1]}:${frame[2]}` : 'unknown';
          // Breadcrumbs: each wallet's last hold (static labels).
          const trail = dWallets.all.map((w) => `${w.name}: ${w.footage.lastAction}`).join('; ');
          recordFinding('failure', `${where} ${unsafe ? '(first line withheld: it carries a secret)' : first} [last: ${trail}]`);
        }
      }
    },
    { auto: true },
  ],
});

export { expect };
