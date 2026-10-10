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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { test as base } from './private-test.js';
import { GuardedFootage, assertStaticLabel, surfaceOf, waitForQuiet } from './guarded-footage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

/**
 * The release candidate this lane was written for: run 11204, source 14a74e10,
 * built through the Builds wrapper b615d731. Hashes are of the staged store zips.
 */
export const RELEASE_CANDIDATE = Object.freeze({
  version: '0.3.1',
  /** Short commits the build stamp may carry: the source, or its Builds wrapper. */
  commits: Object.freeze(['14a74e1', 'b615d73']),
  chromeZip: join(homedir(), 'Build', 'smirk-release', 'v0.3.1-run-11204', 'staged', 'smirk-wallet-chrome-v0.3.1.zip'),
  chromeZipSha256: 'e64fb7aca1012b10cc078fcdc272685e0966e356297a5c8aa59485aa08485776',
  firefoxZipSha256: 'd1bc246338f1fb520717a0e76e125c1a301e9b58743e8a027cadfc2d4e6647c4',
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

/** Production writes (new user rows, handles, profiles) need ALLOW_PROD_WRITES=1. */
export function requireProdWrites(what: string): void {
  if (process.env.ALLOW_PROD_WRITES !== '1') {
    expectedSkip(`${what} writes to production; set ALLOW_PROD_WRITES=1 to run it on purpose`);
  }
}

// ── Profiles and wallets ────────────────────────────────────────────────────

export class LiveProfile {
  page: Page;
  closed = false;
  /** Whether the fresh install opened its setup tab by itself. */
  installTabOpened = false;

  constructor(
    readonly label: string,
    readonly context: BrowserContext,
    readonly extensionId: string,
    readonly dir: string,
    first: Page,
    /** Hostnames this profile contacted since launch (never full URLs). */
    readonly contacted: Set<string>,
  ) {
    this.page = first;
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
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export interface LiveWallet {
  readonly name: string;
  readonly profile: LiveProfile;
  readonly password: SecretValue;
  /** The backend user id the import resolved to (not a secret). */
  userId: string | null;
  /** True when setup greeted a returning identity (handle or linked socials). */
  welcomeBack: boolean;
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

  /** A clean browser profile with the release candidate loaded and no wallet. */
  async profile(label: string, wallet = label): Promise<LiveProfile> {
    assertStaticLabel(label);
    const dist = extensionDist();
    if (!existsSync(join(dist, 'manifest.json'))) throw new Error('no unpacked extension at EXTENSION_DIST; run the live preflight');
    const dir = mkdtempSync(join(this.root, `${label.replace(/[^a-z0-9]+/gi, '-')}-`));
    chmodSync(dir, 0o700);
    const context = await chromium.launchPersistentContext(dir, {
      headless: !process.env.HEADED,
      channel: 'chromium',
      viewport: { ...LIVE_VIEWPORT },
      deviceScaleFactor: LIVE_SCALE,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox'],
    });
    const contacted = new Set<string>();
    // Context-level, so service-worker fetches count too. Hostnames only.
    context.on('request', (request) => {
      const url = request.url();
      if (/^(chrome-extension|data|blob|about|chrome|devtools):/.test(url)) return;
      try { contacted.add(new URL(url).hostname); } catch { contacted.add('unparseable'); }
    });
    this.footage.watch(context, wallet);
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(worker.url()).host;
    const first = context.pages()[0] ?? await context.newPage();
    const profile = new LiveProfile(label, context, extensionId, dir, first, contacted);
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
      return { name, profile, password, userId: outcome.userId, welcomeBack: outcome.welcomeBack };
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
): Promise<{ userId: string | null; welcomeBack: boolean }> {
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
): Promise<{ userId: string | null; welcomeBack: boolean }> {
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
  const userId = await pollUserId(page);
  return { userId, welcomeBack };
}

/**
 * The backend user id from the wallet's bootstrap cache. Only the id leaves the
 * page; the access token beside it never does.
 */
export async function readUserId(page: Page): Promise<string | null> {
  return page.evaluate(async (key) => {
    const chromeApi = (globalThis as unknown as { chrome: { storage: { session: { get(k: string): Promise<Record<string, unknown>> } } } }).chrome;
    const entry = (await chromeApi.storage.session.get(key))[key] as { bootstrap?: { userId?: unknown } } | undefined;
    const id = entry?.bootstrap?.userId;
    return typeof id === 'string' ? id : null;
  }, 'smirk_bootstrap_cache_v1');
}

export async function pollUserId(page: Page, patience = 90_000): Promise<string | null> {
  const deadline = Date.now() + patience;
  while (Date.now() < deadline) {
    const id = await readUserId(page).catch(() => null);
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

/** Type the password into the lock screen (carded) and wait for it to go. */
export async function unlock(footage: GuardedFootage, wallet: LiveWallet, page: Page = wallet.profile.page): Promise<void> {
  const field = page.getByTestId('lockscreen-password-input');
  await expect(field).toBeVisible({ timeout: 60_000 });
  await expect(field).toHaveAttribute('type', 'password');
  await footage.secret('Unlock password', async () => {
    await footage.secretFill(field, wallet.password.reveal(), 'unlock password');
    await footage.tap(page.getByTestId('lockscreen-unlock-btn'), 'unlock');
    await expect(page.getByTestId('lockscreen-root')).toHaveCount(0, { timeout: 60_000 });
  });
}

/** If an operation password prompt appears, answer it (carded). Returns whether it did. */
export async function confirmPasswordIfAsked(
  footage: GuardedFootage,
  wallet: LiveWallet,
  page: Page,
  patience = 5_000,
): Promise<boolean> {
  const field = page.getByTestId('operation-password');
  const shown = await field.waitFor({ state: 'visible', timeout: patience }).then(() => true, () => false);
  if (!shown) return false;
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

/** A tab tap restores its last sub-screen; tapping it again returns to its root. */
export async function tabRoot(footage: GuardedFootage, page: Page, tab: 'home' | 'swap' | 'inbox' | 'settings' | 'feed'): Promise<void> {
  const nav = page.getByTestId(`nav-tab-${tab}`);
  await footage.tap(nav, `open the ${tab} tab`);
  const marker = TAB_ROOT[tab];
  if (marker && !(await page.getByTestId(marker).isVisible().catch(() => false))) {
    await footage.tap(nav, `back to the ${tab} root`);
  }
  if (marker) await expect(page.getByTestId(marker)).toBeVisible({ timeout: 30_000 });
}

/** A usable wallet page on Home: reopened if closed, unlocked if locked. */
export async function openHome(footage: GuardedFootage, wallet: LiveWallet): Promise<Page> {
  let page = wallet.profile.page;
  if (page.isClosed() || surfaceOf(page.url()) !== 'wallet') page = await wallet.profile.openPage();
  const lock = page.getByTestId('lockscreen-root');
  const nav = page.getByTestId('bottom-nav');
  await expect(lock.or(nav).first()).toBeVisible({ timeout: 60_000 });
  if (await lock.isVisible().catch(() => false)) await unlock(footage, wallet, page);
  await expect(nav).toBeVisible({ timeout: 60_000 });
  await tabRoot(footage, page, 'home');
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
  return amounts.map((amount) => amount.replace(/\s+/g, ' ').replace('−', '-'));
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
  }, { auto: true }],
});

export { expect };

/** True when this module runs under playwright.live.config.ts. */
export function onLiveLane(): boolean {
  return process.env.SMIRK_E2E_LANE === 'live';
}
