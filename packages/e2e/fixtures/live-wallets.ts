/**
 * Live wallets: the demo wallets (alice, bob, carol) loaded into real browser
 * profiles of the release candidate, against the production backend, with every
 * page recorded through fixtures/guarded-footage.ts.
 *
 * Custody. A phrase is read in this process, one named line at a time, from an
 * owner-only file (regular file, mode 0600, owned by this user): by default
 * packages/smoke-tests/secrets/smoke-mnemonics.env in this checkout, or
 * E2E_WALLET_FILE (a path, never a value). The file is never sourced into the
 * environment, so no browser or child process inherits it. Words are typed
 * inside a footage secret scope, registered with the canary as hashes, and the
 * array is zeroed straight after import. Each profile gets a random password
 * that lives only in a SecretValue in this process.
 *
 * Profiles live in a 0700 scratch directory and are deleted when the worker
 * ends. Fixtures are worker-scoped: alice, bob and carol are imported once per
 * worker, the first time a test asks for them, and that import is recorded.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { test as base } from './private-test.js';
import { ACTION_TIMEOUT_MS, GuardedFootage, assertStaticLabel, surfaceOf, waitForQuiet } from './guarded-footage.js';
import { watchContext } from './failure-context.js';
import { recoverToHome } from './wallet-recovery.js';
import { RC } from './release-candidate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

/**
 * The release candidate under test (fixtures/release-candidate.json): its
 * source, the Builds wrapper it was built through, and the staged store zips.
 */
export const RELEASE_CANDIDATE = Object.freeze({
  version: RC.version,
  /** Short commits the build stamp may carry: the source, or its Builds wrapper. */
  commits: RC.stampCommits,
  chromeZip: join(RC.stagedDir, RC.chromeZip.file),
  chromeZipSha256: RC.chromeZip.sha256,
  firefoxZipSha256: RC.firefoxZip.sha256,
});

/** The production website the sign-in scenario uses. */
export const WEBSITE_URL = process.env.E2E_WEBSITE_URL ?? 'https://smirk.cash';

export const LIVE_VIEWPORT = Object.freeze({ width: 380, height: 600 });
export const LIVE_SCALE = 2;
export const ASSETS = ['btc', 'ltc', 'xmr', 'wow', 'grin'] as const;
export type AssetId = (typeof ASSETS)[number];

/** Owner-approved demo wallets and the custody variable each one is read from. */
export const DEMO_WALLETS = Object.freeze({
  alice: 'SMOKE_ALICE_MNEMONIC',
  bob: 'SMOKE_BOB_MNEMONIC',
  carol: 'SMOKE_CAROL_MNEMONIC',
});
export type DemoWallet = keyof typeof DEMO_WALLETS;

/** The unpacked release candidate under test (the preflight may unpack it). */
export function extensionDist(): string {
  return process.env.EXTENSION_DIST ?? join(REPO_ROOT, 'packages', 'extension', 'dist');
}

/**
 * A secret held in memory. It never prints: string conversion, JSON and
 * util.inspect all render a placeholder. `reveal` is for typing it, nothing else.
 */
export class SecretValue {
  #value: string;
  constructor(value: string) { this.#value = value; }
  static random(): SecretValue { return new SecretValue(randomBytes(24).toString('base64url')); }
  reveal(): string { return this.#value; }
  clear(): void { this.#value = ''; }
  toString(): string { return '[secret]'; }
  toJSON(): string { return '[secret]'; }
  [inspect.custom](): string { return '[secret]'; }
}

// ── Custody ─────────────────────────────────────────────────────────────────

export function custodyFile(): string {
  return process.env.E2E_WALLET_FILE ?? join(REPO_ROOT, 'packages', 'smoke-tests', 'secrets', 'smoke-mnemonics.env');
}

function assertCustodyFile(file: string): void {
  if (!existsSync(file)) throw new Error('the custody file is not present in this checkout; set E2E_WALLET_FILE to the owner-only file');
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('the custody file must be a regular owner-only (0600) file owned by this user');
  }
}

function assignments(file: string, variable: string): string[] {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(variable)) throw new Error('custody variable names are upper-case identifiers');
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=\\s*(.*)$`);
  return readFileSync(file, 'utf8').split('\n')
    .map((line) => line.match(pattern)?.[1])
    .filter((value): value is string => value !== undefined);
}

/** Whether the custody file holds exactly one phrase for `variable`. Reads no value out. */
export function custodyStatus(variable: string): { ok: true } | { ok: false; reason: string } {
  try {
    const file = custodyFile();
    assertCustodyFile(file);
    const count = assignments(file, variable).length;
    if (count !== 1) return { ok: false, reason: `the custody file has ${count === 0 ? 'no' : 'more than one'} ${variable} assignment` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the custody file could not be read' };
  }
}

/** The phrase for `variable` as words. Same rules as demo/capture-demo.mjs. Zero it after use. */
export function readCustodyPhrase(variable: string): string[] {
  const file = custodyFile();
  assertCustodyFile(file);
  const found = assignments(file, variable);
  if (found.length !== 1) throw new Error(`expected exactly one ${variable} assignment in the custody file`);
  const words = found[0]!.trim().replace(/^(['"])(.*)\1$/, '$2').trim().split(/\s+/);
  if (![12, 24].includes(words.length) || words.some((word) => !/^[a-z]+$/.test(word))) {
    throw new Error(`${variable} is not a 12- or 24-word phrase`);
  }
  return words;
}

/**
 * Overwrite every word of a phrase array in place. A named helper so live
 * specs never call `.fill(`, which the preflight reserves for footage helpers.
 */
export function wipeWords(words: string[]): void {
  for (let i = 0; i < words.length; i++) words[i] = '';
}

// ── Skips ───────────────────────────────────────────────────────────────────

/**
 * Skip with a reason the live skip guard accepts. Use it only for conditions a
 * spec declares in advance (an owner-supplied seed, a funded wallet, an opt-in
 * production write). Any other skip fails the run: a skip is not a pass.
 */
export function expectedSkip(reason: string): never {
  base.info().annotations.push({ type: 'expected-skip', description: reason });
  base.skip(true, reason);
  throw new Error(reason);
}

/**
 * Record a claim this test could not check, with the reason. The test goes on
 * and may pass, but the lane's reporter lists every such line under what the
 * run did not prove, so an unchecked claim is never a silent pass. Reasons are
 * static text, like skip reasons.
 */
export function declareUnproven(reason: string): void {
  base.info().annotations.push({ type: 'unproven', description: reason });
}

/** Production writes (new user rows, handles, profiles) need ALLOW_PROD_WRITES=1. */
export function requireProdWrites(what: string): void {
  if (process.env.ALLOW_PROD_WRITES !== '1') {
    expectedSkip(`${what} writes to production; set ALLOW_PROD_WRITES=1 to run it on purpose`);
  }
}

// ── Network observation ─────────────────────────────────────────────────────

/** Navigations wait this long; the runner's default is no limit at all. */
export const NAVIGATION_TIMEOUT_MS = 120_000;

/**
 * Hosts Chromium itself contacts on a fresh profile, extension or not: account,
 * variations, component, update and safe-browsing services. Seen with no
 * extension loaded, through the same refusing proxy.
 */
const BROWSER_SERVICE_HOST = /(^|\.)(google\.com|googleapis\.com|gvt1\.com|gstatic\.com)$/;

/** The control host the observation proves itself with (.invalid never resolves). */
const PROXY_CONTROL_HOST = 'e2e-proxy-control.invalid';

let bundleText: string | null = null;

/** Every script, page and manifest of the extension under test, as one string. */
function extensionBundleText(): string {
  if (bundleText !== null) return bundleText;
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(m?js|html|json)$/.test(entry.name)) parts.push(readFileSync(path, 'utf8'));
    }
  };
  walk(extensionDist());
  bundleText = parts.join('\n');
  return bundleText;
}

/**
 * Whether a contacted host belongs to the browser rather than the extension.
 * On a fresh profile with no network answered, the extension can only reach a
 * host its own bundle names, so a browser-service host the bundle never names
 * cannot be the extension's. One the bundle does name always counts.
 */
function isBrowserService(host: string): boolean {
  return BROWSER_SERVICE_HOST.test(host) && !extensionBundleText().includes(host);
}

interface RefusingProxy {
  server: string;
  hosts: Set<string>;
  close(): Promise<void>;
}

/**
 * A local proxy that answers every request with 403 and records the host it
 * was for. Given to a profile as its browser-wide proxy, it sees what Playwright
 * request events cannot: the service worker before any listener attaches, the
 * offscreen document (which Playwright detaches from), and WebSocket upgrades.
 */
async function startRefusingProxy(): Promise<RefusingProxy> {
  const hosts = new Set<string>();
  const proxy = createServer((request, response) => {
    try { hosts.add(new URL(request.url ?? '').hostname); } catch { hosts.add('unparseable'); }
    response.writeHead(403, { Connection: 'close' });
    response.end();
  });
  proxy.on('connect', (request, socket) => {
    const host = String(request.url ?? '').replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
    hosts.add(host || 'unparseable');
    socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('the observation proxy did not bind a port');
  return {
    server: `http://127.0.0.1:${address.port}`,
    hosts,
    close: () => new Promise<void>((resolve) => {
      proxy.closeAllConnections();
      proxy.close(() => resolve());
    }),
  };
}

// ── Profiles and wallets ────────────────────────────────────────────────────

export class LiveProfile {
  page: Page;
  closed = false;
  /** Whether the fresh install opened its setup tab by itself. */
  installTabOpened = false;
  /** The refusing proxy of an observed profile, or null for a networked one. */
  private observer: RefusingProxy | null = null;

  constructor(
    readonly label: string,
    readonly context: BrowserContext,
    readonly extensionId: string,
    readonly dir: string,
    first: Page,
    /** Hostnames this profile's pages and workers requested (never full URLs). */
    readonly contacted: Set<string>,
  ) {
    this.page = first;
  }

  /** @internal Set once by LiveWallets for a profile launched behind the refusing proxy. */
  observeWith(observer: RefusingProxy): void {
    this.observer = observer;
  }

  /** Whether this profile runs behind the refusing proxy. */
  get observed(): boolean {
    return this.observer !== null;
  }

  /**
   * Hosts the extension tried to reach: every page or worker request, and on
   * an observed profile every host the browser-wide proxy saw, less the
   * browser's own services (see isBrowserService). Hostnames only.
   */
  extensionContacts(): string[] {
    const proxied = [...(this.observer?.hosts ?? [])].filter((host) => !isBrowserService(host));
    return [...new Set([...this.contacted, ...proxied])].filter((host) => host !== PROXY_CONTROL_HOST).sort();
  }

  /** Browser-service hosts the proxy saw and attributed to Chromium itself. */
  browserContacts(): string[] {
    return [...(this.observer?.hosts ?? [])].filter(isBrowserService).sort();
  }

  /**
   * Prove the observation is live: a request from `page` to a reserved host
   * must reach the proxy. Without this, "nothing contacted" could also mean a
   * proxy that saw nothing at all.
   */
  async proveObservation(page: Page): Promise<boolean> {
    const observer = this.observer;
    if (!observer) return false;
    await page.evaluate((host) => fetch(`http://${host}/`, { cache: 'no-store' }).then(() => {}, () => {}), PROXY_CONTROL_HOST);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !observer.hosts.has(PROXY_CONTROL_HOST)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return observer.hosts.has(PROXY_CONTROL_HOST);
  }

  popupUrl(suffix = ''): string {
    return `chrome-extension://${this.extensionId}/popup.html${suffix}`;
  }

  /** Open the wallet in a new page (recorded) and make it this profile's page. */
  async openPage(suffix = ''): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(this.popupUrl(suffix));
    this.page = page;
    return page;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => {});
    await this.observer?.close().catch(() => {});
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** What onboarding learned about the account; no value here is a secret. */
export interface OnboardingOutcome {
  /** The backend user id the import resolved to. */
  userId: string | null;
  /** True when setup greeted a returning identity (handle or linked socials). */
  welcomeBack: boolean;
  /** The backend's own answer: true when this sign-in created the account; null if unreadable. */
  isNew: boolean | null;
  /** Scan-start heights the backend echoed for the account, when it did. */
  startHeights: { xmr?: number; wow?: number };
}

export interface LiveWallet extends OnboardingOutcome {
  readonly name: string;
  readonly profile: LiveProfile;
  readonly password: SecretValue;
}

export class LiveWallets {
  private readonly root: string;
  private readonly references = new Map<DemoWallet, LiveWallet>();
  private readonly profiles = new Set<LiveProfile>();
  private readonly remembered = new Map<string, LiveWallet>();

  constructor(readonly footage: GuardedFootage) {
    const base = process.env.E2E_LIVE_PROFILES_DIR ?? tmpdir();
    mkdirSync(base, { recursive: true, mode: 0o700 });
    this.root = mkdtempSync(join(base, 'smirk-e2e-live-'));
    chmodSync(this.root, 0o700);
  }

  /**
   * A clean browser profile with the release candidate loaded and no wallet.
   * With `observeNetwork`, the profile runs behind a refusing proxy that records
   * every host the browser tries from launch on, and lets nothing through.
   */
  async profile(label: string, wallet = label, options: { observeNetwork?: boolean } = {}): Promise<LiveProfile> {
    assertStaticLabel(label);
    const dist = extensionDist();
    if (!existsSync(join(dist, 'manifest.json'))) throw new Error('no unpacked extension at EXTENSION_DIST; run the live preflight');
    const dir = mkdtempSync(join(this.root, `${label.replace(/[^a-z0-9]+/gi, '-')}-`));
    chmodSync(dir, 0o700);
    const observer = options.observeNetwork ? await startRefusingProxy() : null;
    const context = await chromium.launchPersistentContext(dir, {
      headless: !process.env.HEADED,
      channel: 'chromium',
      viewport: { ...LIVE_VIEWPORT },
      deviceScaleFactor: LIVE_SCALE,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox'],
      ...(observer ? { proxy: { server: observer.server } } : {}),
    }).catch(async (error: unknown) => {
      await observer?.close();
      throw error;
    });
    // Explicit, whatever the runner's defaults: a missing element fails its
    // step in a minute instead of stalling the run for the test timeout.
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const contacted = new Set<string>();
    // Context-level, so service-worker fetches count too. Hostnames only.
    context.on('request', (request) => {
      const url = request.url();
      if (/^(chrome-extension|data|blob|about|chrome|devtools):/.test(url)) return;
      try { contacted.add(new URL(url).hostname); } catch { contacted.add('unparseable'); }
    });
    this.footage.watch(context, wallet);
    // Request shapes and screen test ids for the private failure log; no values.
    watchContext(label, context);
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(worker.url()).host;
    const first = context.pages()[0] ?? await context.newPage();
    const profile = new LiveProfile(label, context, extensionId, dir, first, contacted);
    if (observer) profile.observeWith(observer);
    // A fresh install opens setup in a tab by itself (background onInstalled),
    // a moment after launch. Wait for it and close it, so each scenario starts
    // from the surface it names and a later page event is never that tab.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const tab = context.pages().find((page) => /popup\.html\?ctx=tab/.test(page.url()));
      if (tab) {
        profile.installTabOpened = true;
        await tab.close();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.profiles.add(profile);
    return profile;
  }

  /** The worker's reference profile for a demo wallet, imported (and recorded) on first use. */
  async reference(name: DemoWallet): Promise<LiveWallet> {
    const known = this.references.get(name);
    if (known && !known.profile.closed) return known;
    const profile = await this.profile(name);
    const wallet = await this.importInto(profile, DEMO_WALLETS[name], name);
    this.references.set(name, wallet);
    return wallet;
  }

  /** True once the reference profile for `name` exists in this worker. */
  hasReference(name: DemoWallet): boolean {
    const known = this.references.get(name);
    return Boolean(known && !known.profile.closed);
  }

  /** Import the phrase held under `variable` into `profile`, recorded. */
  async importInto(profile: LiveProfile, variable: string, name: string): Promise<LiveWallet> {
    const status = custodyStatus(variable);
    if (!status.ok) throw new Error(`${name} cannot be loaded: ${status.reason}`);
    const password = SecretValue.random();
    this.footage.canary.addSecret(password.reveal());
    const words = readCustodyPhrase(variable);
    try {
      const outcome = await importPhrase(this.footage, profile, words, password);
      return { name, profile, password, ...outcome };
    } finally {
      words.fill('');
    }
  }

  /** Keep a wallet a later test in this worker needs (the newly created one). */
  remember(key: string, wallet: LiveWallet): void { this.remembered.set(key, wallet); }
  recall(key: string): LiveWallet | undefined {
    const wallet = this.remembered.get(key);
    return wallet && !wallet.profile.closed ? wallet : undefined;
  }

  async dispose(): Promise<void> {
    for (const profile of this.profiles) await profile.close();
    for (const wallet of [...this.references.values(), ...this.remembered.values()]) wallet.password.clear();
    rmSync(this.root, { recursive: true, force: true });
  }
}

// ── Recorded wallet steps ───────────────────────────────────────────────────

/**
 * The import wizard, recorded: welcome, warning, phrase (carded), password
 * (carded, and asserted masked), returning-user bootstrap, Home with a real
 * balance set. The words array is the caller's to zero.
 */
export async function importPhrase(
  footage: GuardedFootage,
  profile: LiveProfile,
  words: string[],
  password: SecretValue,
): Promise<OnboardingOutcome> {
  const page = profile.page;
  await page.goto(profile.popupUrl());
  await expect(page.getByTestId('onboarding-import-btn')).toBeVisible({ timeout: 60_000 });
  await footage.settled(page, 'welcome screen');
  await footage.tap(page.getByTestId('onboarding-import-btn'), 'import an existing wallet');
  await footage.settled(page, 'import warning');
  await footage.tap(page.getByTestId('onboarding-import-warning-continue'), 'continue past the warning');

  footage.canary.addPhrase(words);
  await footage.secret('Recovery phrase entry', async () => {
    await expect(page.getByTestId('onboarding-import-word-0')).toBeVisible({ timeout: 30_000 });
    for (let i = 0; i < words.length; i++) {
      await footage.secretFill(page.getByTestId(`onboarding-import-word-${i}`), words[i]!, 'phrase word');
    }
    await footage.tap(page.getByTestId('onboarding-import-continue'), 'continue with the phrase');
  });

  await setPasswordAndSubmit(footage, page, password);
  return finishOnboarding(footage, page);
}

/** The password step shared by create and import: masked, carded, submitted. */
export async function setPasswordAndSubmit(footage: GuardedFootage, page: Page, password: SecretValue): Promise<void> {
  const field = page.getByTestId('onboarding-password-input');
  const confirm = page.getByTestId('onboarding-password-confirm-input');
  await expect(field).toBeVisible({ timeout: 60_000 });
  // The password is masked on screen, not merely hidden from the recording.
  await expect(field).toHaveAttribute('type', 'password');
  await expect(confirm).toHaveAttribute('type', 'password');
  await footage.settled(page, 'password step');
  const submit = page.getByTestId('onboarding-set-password-submit');
  await footage.secret('Password entry', async () => {
    // The wizard fails closed until the backend's sign-up requirements load,
    // and its retry clears the fields, so re-enter before each press. Only that
    // race is retried: any other refusal would spend the wallet's restore budget.
    for (let attempt = 0; attempt < 4; attempt++) {
      await footage.secretFill(field, password.reveal(), 'password');
      await footage.secretFill(confirm, password.reveal(), 'password confirmation');
      await footage.tap(submit, 'set the password');
      await submit.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
      if (!(await submit.isVisible().catch(() => false))) break;
      if (!/sign-up requirements/.test(await page.locator('#root').innerText())) break;
      await footage.hold('settled', 'waiting for sign-up requirements', page);
    }
  });
}

/** After the password: setup (if shown), then Home with a real balance set. */
export async function finishOnboarding(
  footage: GuardedFootage,
  page: Page,
): Promise<OnboardingOutcome> {
  const finish = page.getByTestId('onboarding-setup-finish-btn');
  const home = page.getByTestId('bottom-nav');
  const failed = page.getByTestId('bootstrap-error');
  // Registration may mine proof of work and a returning wallet's restore check
  // may too, so this waits far longer than a UI step.
  await expect(finish.or(home).or(failed).first()).toBeVisible({ timeout: 20 * 60_000 });
  if (await failed.isVisible().catch(() => false)) {
    throw new Error(`bootstrap failed on screen: ${(await failed.innerText()).replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  let welcomeBack = false;
  if (await finish.isVisible().catch(() => false)) {
    welcomeBack = await page.getByText(/Welcome back/).first().isVisible().catch(() => false);
    await footage.result(page, 'setup step');
    await footage.tap(finish, 'finish setup');
  }
  await expect(home).toBeVisible({ timeout: 5 * 60_000 });
  // A resolved fiat figure is the auth signal: it stays a placeholder when the
  // offscreen token is missing (see fixtures/onboard.ts).
  const total = page.getByTestId('home-total-balance');
  await expect.poll(async () => (await total.textContent().catch(() => ''))?.trim() ?? '', {
    timeout: 10 * 60_000,
    message: 'the fiat total never resolved, so the wallet never received a balance set from the backend',
  }).toMatch(/\d/);
  const facts = await pollBootstrapFacts(page);
  return { ...facts, welcomeBack };
}

/** The non-secret part of the wallet's bootstrap: who the backend says this is. */
export interface BootstrapFacts {
  userId: string | null;
  isNew: boolean | null;
  startHeights: { xmr?: number; wow?: number };
}

/**
 * The account facts from the wallet's bootstrap cache: user id, whether the
 * sign-in created the account, and the scan-start heights. Only these cross out
 * of the page; the access token beside them never does.
 */
export async function readBootstrapFacts(page: Page): Promise<BootstrapFacts> {
  return page.evaluate(async (key) => {
    const chromeApi = (globalThis as unknown as { chrome: { storage: { session: { get(k: string): Promise<Record<string, unknown>> } } } }).chrome;
    const entry = (await chromeApi.storage.session.get(key))[key] as
      | { bootstrap?: { userId?: unknown; isNew?: unknown; xmrStartHeight?: unknown; wowStartHeight?: unknown } }
      | undefined;
    const bootstrap = entry?.bootstrap;
    const height = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
    const xmr = height(bootstrap?.xmrStartHeight);
    const wow = height(bootstrap?.wowStartHeight);
    return {
      userId: typeof bootstrap?.userId === 'string' ? bootstrap.userId : null,
      isNew: typeof bootstrap?.isNew === 'boolean' ? bootstrap.isNew : null,
      startHeights: { ...(xmr === undefined ? {} : { xmr }), ...(wow === undefined ? {} : { wow }) },
    };
  }, 'smirk_bootstrap_cache_v1');
}

/** The backend user id alone (see readBootstrapFacts). */
export async function readUserId(page: Page): Promise<string | null> {
  return (await readBootstrapFacts(page)).userId;
}

export async function pollBootstrapFacts(page: Page, patience = 90_000): Promise<BootstrapFacts> {
  const deadline = Date.now() + patience;
  while (Date.now() < deadline) {
    const facts = await readBootstrapFacts(page).catch(() => null);
    if (facts?.userId) return facts;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { userId: null, isNew: null, startHeights: {} };
}

export async function pollUserId(page: Page, patience = 90_000): Promise<string | null> {
  return (await pollBootstrapFacts(page, patience)).userId;
}

/** Type the password into the lock screen (carded), wait for it to go, and hold what it uncovers. */
export async function unlock(footage: GuardedFootage, wallet: LiveWallet, page: Page = wallet.profile.page): Promise<void> {
  const field = page.getByTestId('lockscreen-password-input');
  await expect(field).toBeVisible({ timeout: 60_000 });
  await expect(field).toHaveAttribute('type', 'password');
  await footage.secret('Unlock password', async () => {
    await footage.secretFill(field, wallet.password.reveal(), 'unlock password');
    await footage.tap(page.getByTestId('lockscreen-unlock-btn'), 'unlock');
    await expect(page.getByTestId('lockscreen-root')).toHaveCount(0, { timeout: 60_000 });
  });
  await footage.settled(page, 'unlocked');
}

/**
 * If an operation password prompt appears, answer it (carded). Returns whether
 * it did. With `outcome`, the wait ends as soon as either the prompt or the
 * operation's own result shows, so a slow prompt is never taken for no prompt
 * and a prompt-free operation costs no waiting.
 */
export async function confirmPasswordIfAsked(
  footage: GuardedFootage,
  wallet: LiveWallet,
  page: Page,
  options: { patience?: number; outcome?: Locator } = {},
): Promise<boolean> {
  const field = page.getByTestId('operation-password');
  const patience = options.patience ?? 60_000;
  const either = options.outcome ? field.or(options.outcome).first() : field;
  const appeared = await either.waitFor({ state: 'visible', timeout: patience }).then(() => true, () => false);
  if (!appeared || !(await field.isVisible().catch(() => false))) return false;
  await expect(field).toHaveAttribute('type', 'password');
  await footage.secret('Operation password', async () => {
    await footage.secretFill(field, wallet.password.reveal(), 'operation password');
    await footage.tap(page.getByTestId('operation-password-confirm'), 'confirm with password');
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 });
  });
  return true;
}

const TAB_ROOT: Record<string, string> = {
  home: 'home-total-balance',
  settings: 'settings-lock-now-btn',
};

/**
 * A tab tap restores its last sub-screen; tapping it again returns to its root.
 * The root is then held for the settled period, like every screen.
 */
export async function tabRoot(footage: GuardedFootage, page: Page, tab: 'home' | 'swap' | 'inbox' | 'settings' | 'feed'): Promise<void> {
  const nav = page.getByTestId(`nav-tab-${tab}`);
  await footage.tap(nav, `open the ${tab} tab`);
  const marker = TAB_ROOT[tab];
  if (marker && !(await page.getByTestId(marker).isVisible().catch(() => false))) {
    await footage.tap(nav, `back to the ${tab} root`);
  }
  if (marker) await expect(page.getByTestId(marker)).toBeVisible({ timeout: 30_000 });
  await footage.settled(page, `${tab} tab`);
}

/**
 * Recorded moves take the owner's holds (a settle and a pre-tap pause each),
 * so a recorded recovery gets this long; an unrecorded one, its default.
 */
const RECORDED_RECOVERY_MS = 5 * 60_000;

/**
 * A usable wallet page on Home's root, held settled: reopened if closed,
 * unlocked if locked, and brought back from whatever screen the wallet
 * restored (fixtures/wallet-recovery.ts), every move a recorded tap.
 */
export async function openHome(footage: GuardedFootage, wallet: LiveWallet): Promise<Page> {
  let page = wallet.profile.page;
  if (page.isClosed() || surfaceOf(page.url()) !== 'wallet') page = await wallet.profile.openPage();
  const recover = () =>
    recoverToHome(page, {
      wallet: wallet.name,
      budgetMs: RECORDED_RECOVERY_MS,
      tap: (target, label) => footage.tap(target, label),
      press: (target, key, label) => footage.press(target, key, label),
    });
  let { reached } = await recover();
  if (reached === 'locked') {
    await unlock(footage, wallet, page);
    ({ reached } = await recover());
  }
  if (reached !== 'home') throw new Error(`${wallet.name} shows ${reached}, not Home`);
  await footage.settled(page, 'home tab');
  return page;
}

/** Settings root, then one of its sections. */
export async function settingsSection(
  footage: GuardedFootage,
  page: Page,
  navId: string,
  screenId: string,
  label: string,
): Promise<void> {
  await tabRoot(footage, page, 'settings');
  await footage.tap(page.getByTestId(navId), label);
  await expect(page.getByTestId(screenId)).toBeVisible({ timeout: 30_000 });
  await footage.settled(page, label);
}

/** The active npub, read from Settings, Nostr identity. */
export async function readNpub(footage: GuardedFootage, page: Page): Promise<string> {
  await settingsSection(footage, page, 'settings-nostr-nav', 'settings-nostr-screen', 'Nostr identity');
  const npub = page.getByTestId('nostr-npub');
  await expect(npub).toContainText(/npub1[0-9a-z]{20,}/, { timeout: 30_000 });
  return ((await npub.textContent()) ?? '').trim();
}

/**
 * Home's per-asset balance text, once none is still loading. An asset the
 * wallet hides has no row and is reported as an empty string.
 */
export async function homeBalances(page: Page, patience = 5 * 60_000): Promise<Record<AssetId, string>> {
  const read = async () => {
    const out = {} as Record<AssetId, string>;
    for (const asset of ASSETS) {
      const cell = page.getByTestId(`asset-row-${asset}-balance`);
      out[asset] = (await cell.count()) ? ((await cell.textContent()) ?? '').trim() : '';
    }
    return out;
  };
  await expect.poll(async () => {
    const balances = await read();
    // The balance cell shows an em dash placeholder while it loads.
    return Object.values(balances).some((value) => value === '—') || Object.values(balances).every((value) => value === '');
  }, { timeout: patience, message: 'a Home balance stayed in its loading state' }).toBe(false);
  return read();
}

/** True when the balance text is a positive amount. */
export function isPositive(balance: string): boolean {
  const figure = balance.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return figure ? Number(figure[0]) > 0 : false;
}

const AMOUNT = /[+\-−]?\s?\d[\d,]*(?:\.\d+)?\s?(?:BTC|LTC|XMR|WOW|GRIN|sats?)\b/g;

/** Open an asset's detail, hold it, read the amounts in its Activity list, go back. */
export async function historyAmounts(footage: GuardedFootage, page: Page, asset: AssetId): Promise<string[]> {
  await footage.tap(page.getByTestId(`asset-row-${asset}`), `open ${asset} detail`);
  await expect(page.getByTestId('asset-detail-balance')).toBeVisible({ timeout: 30_000 });
  await waitForQuiet(page, 5 * 60_000);
  const text = await page.locator('#root').innerText();
  const at = text.search(/activity/i);
  const amounts = (at >= 0 ? text.slice(at) : '').match(AMOUNT) ?? [];
  await footage.result(page, 'asset history');
  await footage.tap(page.getByTestId('asset-detail-back'), 'back to Home');
  await expect(page.getByTestId('home-total-balance')).toBeVisible({ timeout: 30_000 });
  await footage.settled(page, 'back on Home');
  return amounts.map((amount) => amount.replace(/\s+/g, ' ').replace('−', '-'));
}

/** A displayed amount as a canonical decimal string: no grouping, no trailing zeros. */
export function canonicalAmount(text: string): string | null {
  const figure = text.replace(/,/g, '').match(/\d+(?:\.\d+)?/)?.[0];
  if (!figure) return null;
  const [whole, fraction = ''] = figure.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${whole!.replace(/^0+(?=\d)/, '')}${trimmed ? `.${trimmed}` : ''}`;
}

/**
 * Which expected incoming amounts a history list lacks. Each expected amount
 * must match its own incoming entry ("+ 0.05 XMR"), so two receipts of the same
 * size need two entries.
 */
export function missingReceipts(history: readonly string[], ticker: string, expected: readonly string[]): string[] {
  const pool = history
    .filter((entry) => /^\+/.test(entry.trim()) && new RegExp(`\\b${ticker}$`).test(entry.trim()))
    .map(canonicalAmount);
  const missing: string[] = [];
  for (const amount of expected) {
    const at = pool.indexOf(canonicalAmount(amount));
    if (at < 0) missing.push(amount);
    else pool.splice(at, 1);
  }
  return missing;
}

/** Each asset's ticker as the history shows it. */
export const TICKERS: Readonly<Record<AssetId, string>> = Object.freeze({
  btc: 'BTC', ltc: 'LTC', xmr: 'XMR', wow: 'WOW', grin: 'GRIN',
});

/**
 * A sent tip as the Sent tips list shows it: the collapsed card's text
 * ("0.01 XMR → link", when, the badge) and its status badge alone.
 */
export interface SentTipSummary { line: string; status: string }

/**
 * Open Settings, Sent tips, and read each collapsed card's text and status.
 * Only those strings leave the page; a claim link appears only in an expanded
 * card, and no card is expanded here.
 */
export async function sentTipSummaries(footage: GuardedFootage, page: Page): Promise<SentTipSummary[]> {
  await tabRoot(footage, page, 'settings');
  await footage.tap(page.getByTestId('settings-sent-tips-nav'), 'Sent tips');
  const cards = page.locator('[data-testid^="sent-tip-card-"]');
  await expect(cards.first().or(page.getByText('No tips sent yet')).first(), 'the Sent tips list never loaded').toBeVisible({ timeout: 60_000 });
  await waitForQuiet(page);
  // innerText, not textContent: the card's amount line and its relative date
  // are sibling blocks, and textContent joins them with no space ("link3mo ago"),
  // so a word boundary after the recipient never matches.
  const summaries = await cards.evaluateAll((elements) => elements.map((element) => ({
    line: ((element.querySelector('[data-testid="sent-tip-toggle"]') as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim(),
    status: (element.querySelector('[data-testid="sent-tip-status-badge"]')?.textContent ?? '').trim(),
  })));
  await footage.result(page, 'sent tips');
  return summaries;
}

// ── The lane's test object ──────────────────────────────────────────────────

/** A chapter label from a test title: the same words, minus anything a label refuses. */
function chapterLabel(title: string): string {
  const cleaned = title.replace(/[^A-Za-z0-9 ,.'()&:#+-]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^[A-Za-z]/.test(cleaned) ? cleaned.slice(0, 100) : `Scenario ${cleaned}`.slice(0, 100);
}

export const test = base.extend<{ liveChapter: void }, { footage: GuardedFootage; wallets: LiveWallets }>({
  footage: [async ({}, use, workerInfo) => {
    const footage = GuardedFootage.fromEnv(workerInfo.workerIndex, LIVE_SCALE);
    try {
      await use(footage);
    } finally {
      await footage.stop();
    }
    // Teardown encodes one video per recorded page; a full run has hours of them.
  }, { scope: 'worker', timeout: 3 * 60 * 60_000 }],

  wallets: [async ({ footage }, use) => {
    const wallets = new LiveWallets(footage);
    try {
      await use(wallets);
    } finally {
      await wallets.dispose();
    }
  }, { scope: 'worker', timeout: 10 * 60_000 }],

  liveChapter: [async ({ footage }, use, testInfo) => {
    footage.chapter(chapterLabel(testInfo.title));
    await use();
    // The last screen of every step gets its settled hold too, on every open
    // page whose frame changed since its last one, even when no tap follows.
    await footage.settleAll();
  }, { auto: true }],
});

export { expect };

/** True when this module runs under playwright.live.config.ts. */
export function onLiveLane(): boolean {
  return process.env.SMIRK_E2E_LANE === 'live';
}
