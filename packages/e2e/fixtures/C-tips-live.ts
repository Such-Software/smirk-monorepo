/**
 * C-tips live lane: alice, bob and carol in three persistent Chromium profiles
 * of the verified release build, recorded by the guarded footage recorder.
 * Run it only through C-tips.live.config.ts, whose global setup verifies the
 * release zip, unpacks it and sets EXTENSION_DIST.
 *
 * Gates, each its own explicit opt-in (closed by default):
 *   C_TIPS_INVOCATION      set by C-tips.live.config.ts; the main suite never sets it
 *   E2E_LIVE=1             drive the backend under test with the demo wallets
 *   E2E_LIVE_MONEY=1       move real funds (small amounts, among the three)
 *   ALLOW_PROD_WRITES=1    required when BACKEND_URL is a shared host
 *   FOOTAGE=guarded        the release run is recorded; nothing runs unrecorded
 * HEADED is refused: a visible window would show the unrecorded phrase-import
 * page to any desktop screen recorder.
 *
 * Custody: each phrase is read in-process through readWalletPhrase from the
 * owner-only file named by SMOKE_WALLET_FILE. The file is never sourced into
 * the environment, so no browser or child process inherits a phrase. Phrases
 * are typed only into the unrecorded setup page, then zeroed.
 *
 * Funds safety: a link tip's key backup lives only in its sender's profile, and
 * a failed test restarts the worker. So the profiles live in the run's state
 * directory (0700), every tip is written to the ledger the moment its id is
 * known (C-tips-ledger.ts), and a new worker reopens the same profiles instead
 * of importing again. Each wallet's password is derived from its phrase and a
 * per-run salt, so a reopened profile unlocks without any password on disk.
 * The run's global teardown deletes the profiles only when every ledger tip is
 * settled; otherwise it keeps them and writes RECOVERY.md (rescue command).
 */
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytesToHex, decodeNpub, encodeNpub, hexToBytes, shortNpub } from '@smirk/core';
import { test as base } from './private-test.js';
import { BACKEND_URL, isSharedBackend } from './extension.js';
import { WALLET_VARIABLES, readWalletPhrase, walletFileExists, walletFilePath } from './C-tips-custody.mjs';
import { DEVICE_SCALE, GuardedFootage, VIEWPORT, footageMode } from './C-tips-footage.js';
import { TipLedger, type LedgerWalletName } from './C-tips-ledger.js';
import { invocationId, privateDir, runLabel, stateDir } from './C-tips-run.mjs';

export type WalletName = LedgerWalletName;
/** The three demo wallets every scenario uses. `bob-fed` is bob on a second backend. */
export const WALLET_NAMES: readonly WalletName[] = ['alice', 'bob', 'carol'];

export interface LiveWallet {
  readonly name: WalletName;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly extensionId: string;
  /** Active Nostr identity, x-only hex (public). */
  readonly pubkeyHex: string;
  readonly npub: string;
  /** The app's short form, `npub1abcd…wxyz`, as tip rows display it. */
  readonly shortNpub: string;
  /** `name@domain` when the wallet has a claimed, verified Smirk handle. */
  readonly handle: string | null;
}

/** Passwords never sit on the wallet object, so no serialization can carry one. */
const passwords = new Map<WalletName, string>();

export function walletPassword(wallet: Pick<LiveWallet, 'name'>): string {
  const password = passwords.get(wallet.name);
  if (!password) throw new Error(`${wallet.name} has no session password`);
  return password;
}

/** True in a rescue run: it settles an earlier invocation's tips and creates none. */
export function rescueMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.E2E_LIVE_RESCUE === '1';
}

/**
 * Why the live lane must not run here, or null when every gate is open. Reads
 * only the environment Playwright starts with: test collection happens before
 * the global setup, so nothing the setup derives may decide a skip.
 */
export function liveGateReason(env: Record<string, string | undefined> = process.env): string | null {
  if (!(env.C_TIPS_INVOCATION ?? '').trim()) {
    return 'live lane closed: run it through C-tips.live.config.ts (npx playwright test -c C-tips.live.config.ts)';
  }
  if (env.E2E_LIVE !== '1') {
    return 'live lane closed: set E2E_LIVE=1 to drive the backend under test with the demo wallets';
  }
  if (env.E2E_LIVE_MONEY !== '1') return 'SPENDS REAL FUNDS: set E2E_LIVE_MONEY=1 to run';
  if (isSharedBackend() && env.ALLOW_PROD_WRITES !== '1') {
    return `BACKEND_URL ${BACKEND_URL} is a shared host: set ALLOW_PROD_WRITES=1 to write to it`;
  }
  if (!walletFileExists(env)) {
    return 'wallet custody file not found: set SMOKE_WALLET_FILE to the owner-only (0600) demo wallet file';
  }
  let mode: 'guarded' | 'off';
  try {
    mode = footageMode(env);
  } catch (error) {
    return error instanceof Error ? error.message : 'FOOTAGE is not a recognized mode';
  }
  if (mode !== 'guarded') return 'the release run is recorded: set FOOTAGE=guarded (an unrecorded live run proves no video policy)';
  if ((env.HEADED ?? '').trim()) {
    return 'HEADED is refused while recording: a visible window shows the unrecorded phrase-import page to any screen recorder';
  }
  return null;
}

/** The release build under test. C-tips.live.config.ts sets it after verifying the zip. */
export function extensionDist(env: Record<string, string | undefined> = process.env): string {
  const dist = (env.EXTENSION_DIST ?? '').trim();
  if (!dist || !existsSync(join(dist, 'manifest.json'))) {
    throw new Error('EXTENSION_DIST is not the verified release build: run through C-tips.live.config.ts');
  }
  return dist;
}

export function shortNpubFromHex(pubkeyHex: string): string {
  return shortNpub(encodeNpub(hexToBytes(pubkeyHex)));
}

/** The run's private state directory (profiles, ledger, salt). */
export function laneStateDir(): string {
  return privateDir(stateDir());
}

export function profilesDir(): string {
  return privateDir(join(laneStateDir(), 'profiles'));
}

/** The per-run salt: not secret on its own, and useless without the phrase. */
function runSalt(): Buffer {
  const file = join(laneStateDir(), 'salt');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

/** A wallet password derived from its phrase and the run salt: reproducible, never stored. */
function derivePassword(name: WalletName, words: readonly string[]): string {
  return createHmac('sha256', runSalt())
    .update(`smirk-e2e C-tips wallet password\n${name}\n${words.join(' ')}`)
    .digest('base64url');
}

/** Tapping a tab restores its last sub-screen; tapping again returns to its root. */
async function setupTabRoot(page: Page, tab: string): Promise<void> {
  await page.getByTestId(`nav-tab-${tab}`).click();
  await page.getByTestId(`nav-tab-${tab}`).click();
}

/**
 * An unlocked popup reopens on the screen it was left on: after a failed test
 * that can be a tip composer, a send or its receipt rather than Home. Return to
 * Home the way a user would (tap the Home tab, then again for its root), so a
 * restarted worker reaches the same starting point as a fresh one.
 */
async function backToHome(page: Page): Promise<void> {
  const home = page.getByTestId('home-total-balance');
  for (let attempt = 0; attempt < 3 && !(await home.isVisible().catch(() => false)); attempt++) {
    await setupTabRoot(page, 'home');
    await home.waitFor({ timeout: 60_000 }).catch(() => undefined);
  }
}

/** What a freshly opened popup shows. */
async function popupState(page: Page): Promise<'onboarding' | 'locked' | 'home'> {
  const onboarding = page.getByTestId('onboarding-import-btn');
  const locked = page.getByTestId('lockscreen-password-input');
  const home = page.getByTestId('home-total-balance');
  const nav = page.getByTestId('bottom-nav');
  await onboarding.or(locked).or(home).or(nav).first().waitFor({ timeout: 90_000 });
  if (await locked.isVisible().catch(() => false)) return 'locked';
  if (await onboarding.isVisible().catch(() => false)) return 'onboarding';
  await backToHome(page);
  return 'home';
}

async function waitForBalances(page: Page): Promise<void> {
  const total = page.getByTestId('home-total-balance');
  await total.waitFor({ timeout: 10 * 60_000 });
  await expect
    .poll(async () => /\d/.test((await total.textContent()) ?? ''), {
      timeout: 5 * 60_000,
      message: 'the wallet never loaded a real balance set from the backend',
    })
    .toBe(true);
}

/**
 * Import one wallet on a page nothing records. Mirrors the reviewed demo lane's
 * setup, including its capabilities-race retry, but waits on the screen's own
 * state instead of fixed sleeps.
 */
async function importWallet(page: Page, words: string[], password: string): Promise<void> {
  await page.getByTestId('onboarding-import-btn').click({ timeout: 60_000 });
  await page.getByTestId('onboarding-import-warning-continue').click();
  for (let i = 0; i < words.length; i++) await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i]!);
  await page.getByTestId('onboarding-import-continue').click();
  const submit = page.getByTestId('onboarding-set-password-submit');
  const finish = page.getByTestId('onboarding-setup-finish-btn');
  const home = page.getByTestId('home-total-balance');
  const raceText = /sign-up requirements/;
  for (let attempt = 1; ; attempt++) {
    // The wizard rebuilds this step with empty fields after a refusal: re-enter before each press.
    await page.getByTestId('onboarding-password-input').fill(password);
    await page.getByTestId('onboarding-password-confirm-input').fill(password);
    const capabilities = page
      .waitForResponse((r) => new URL(r.url()).pathname.endsWith('/capabilities'), { timeout: 30_000 })
      .catch(() => null);
    await submit.click();
    // Either the step moves on (submitting, then setup or Home), or it reports the
    // capabilities race at once.
    await expect
      .poll(async () => !(await submit.isVisible().catch(() => false)) || raceText.test(await page.locator('#root').innerText()), {
        timeout: 30_000,
        message: 'the password step neither moved on nor said why',
      })
      .toBe(true);
    if (!(await submit.isVisible().catch(() => false))) break;
    // Retry only the capabilities race: every other refusal would spend the
    // backend's per-wallet restore budget. The wizard re-reads capabilities on
    // the refusal; wait for that read rather than a fixed time.
    if (attempt >= 4) throw new Error('the backend capabilities never resolved for sign-up');
    await capabilities;
  }
  await finish.or(home).or(submit).first().waitFor({ timeout: 10 * 60_000 });
  if (await submit.isVisible().catch(() => false)) {
    // Names only: the step's message may quote backend text, never typed values.
    throw new Error('the import was refused on the password step after submitting');
  }
  if (await finish.isVisible().catch(() => false)) await finish.click({ timeout: 25_000 });
  await waitForBalances(page);
}

async function unlockExisting(page: Page, password: string): Promise<void> {
  await page.getByTestId('lockscreen-password-input').fill(password);
  await page.getByTestId('lockscreen-unlock-btn').click();
  const error = page.getByTestId('lockscreen-error');
  await page.getByTestId('home-total-balance').or(error).or(page.getByTestId('bottom-nav')).first().waitFor({ timeout: 5 * 60_000 });
  if (await error.isVisible().catch(() => false)) {
    throw new Error('the kept profile does not unlock with this run\'s derived password (was the run salt replaced?)');
  }
  await backToHome(page);
  await waitForBalances(page);
}

async function maximizeAutoLock(page: Page): Promise<void> {
  await setupTabRoot(page, 'settings');
  const select = page.getByTestId('settings-autolock-select');
  await select.waitFor({ timeout: 30_000 });
  const values = await select.locator('option').evaluateAll((options) =>
    options.map((o) => Number((o as HTMLOptionElement).value)).filter((v) => Number.isFinite(v)),
  );
  await select.selectOption(String(Math.max(...values)));
}

/** Point the wallet at another operator through Settings > Backend (unrecorded setup). */
async function switchBackend(page: Page, url: string): Promise<void> {
  const host = new URL(url).host;
  const stored = async () =>
    page.evaluate(async () => {
      const api = (globalThis as unknown as { chrome: { storage: { local: { get: (k: string) => Promise<Record<string, unknown>> } } } })
        .chrome;
      return JSON.stringify((await api.storage.local.get('smirk_backend_v1'))['smirk_backend_v1'] ?? null);
    });
  if ((await stored()).includes(host)) return;
  await setupTabRoot(page, 'settings');
  await page.getByTestId('settings-backend-nav').click({ timeout: 30_000 });
  await page.getByTestId('backend-url-input').fill(url);
  await page.getByTestId('backend-connect-btn').click();
  await page.getByTestId('backend-probe-result').waitFor({ timeout: 60_000 });
  await page.getByTestId('backend-use-btn').click();
  await expect.poll(async () => (await stored()).includes(host), { timeout: 60_000 }).toBe(true);
}

async function readIdentity(page: Page): Promise<{ pubkeyHex: string; npub: string; handle: string | null }> {
  await setupTabRoot(page, 'settings');
  await page.getByTestId('settings-nostr-nav').click();
  await page.getByTestId('settings-nostr-screen').waitFor({ timeout: 30_000 });
  const npubText = ((await page.getByTestId('nostr-npub').textContent({ timeout: 30_000 })) ?? '').trim();
  const npub = npubText.match(/npub1[02-9ac-hj-np-z]{58}/)?.[0];
  if (!npub) throw new Error('the active Nostr identity did not render an npub');
  const handleBox = page.getByTestId('nostr-handle');
  await handleBox.or(page.getByTestId('nostr-handle-absent')).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  return { pubkeyHex: bytesToHex(decodeNpub(npub)), npub, handle: await verifiedHandleShown(page) };
}

/** The handle the identity screen shows as verified (linked to this key), or null. */
export async function verifiedHandleShown(page: Page): Promise<string | null> {
  const handleBox = page.getByTestId('nostr-handle');
  if (!(await handleBox.isVisible().catch(() => false))) return null;
  // The box's spans read "Your Smirk handle", "<name>@<domain>", then the link state.
  const shown = ((await handleBox.locator('span').nth(1).textContent()) ?? '').trim();
  const name = shown.match(/^([a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,})$/i)?.[1];
  // Only a handle linked to this identity resolves to it.
  return name && /verified/i.test((await handleBox.textContent()) ?? '') ? name.toLowerCase() : null;
}

/** One REQ a wallet page sent to a relay: filter metadata only, never content. */
export interface RelayRequest {
  page: string;
  at: number;
  kinds: number[];
  p: string[];
}

export class TipLane {
  readonly footage = new GuardedFootage();
  readonly wallets = new Map<WalletName, LiveWallet>();
  readonly ledger = new TipLedger(laneStateDir(), runLabel(), invocationId());
  /** Claim links read this session, by tip id. Memory only. */
  readonly links = new Map<string, import('./C-tips-actions.js').SecretLink>();
  readonly openedAt = Date.now();
  private readonly relayRequests: RelayRequest[] = [];

  wallet(name: WalletName): LiveWallet {
    const wallet = this.wallets.get(name);
    if (!wallet) throw new Error(`${name} is not loaded`);
    return wallet;
  }

  get alice(): LiveWallet {
    return this.wallet('alice');
  }
  get bob(): LiveWallet {
    return this.wallet('bob');
  }
  get carol(): LiveWallet {
    return this.wallet('carol');
  }

  static async open(): Promise<TipLane> {
    const lane = new TipLane();
    try {
      for (const name of WALLET_NAMES) await lane.load(name);
      // Recording starts only once every wallet is on Home.
      for (const wallet of lane.wallets.values()) await lane.startRecording(wallet);
      return lane;
    } catch (error) {
      await lane.close().catch(() => undefined);
      throw error;
    }
  }

  /** Bob's phrase in a fourth profile, switched to a second, independent backend. */
  async openFederated(backendUrl: string): Promise<LiveWallet> {
    const existing = this.wallets.get('bob-fed');
    if (existing) return existing;
    await this.load('bob-fed', { phraseOf: 'bob', backendUrl });
    const wallet = this.wallet('bob-fed');
    await this.startRecording(wallet);
    return wallet;
  }

  private async startRecording(wallet: LiveWallet): Promise<void> {
    await setupTabRoot(wallet.page, 'home');
    await wallet.page.getByTestId('home-total-balance').waitFor({ timeout: 60_000 });
    this.footage.attach(wallet.name, wallet.page);
    wallet.context.on('page', (page) => this.footage.attach(`${wallet.name}-tab`, page));
  }

  /** REQs `wallet`'s pages sent since `sinceMs`. */
  requestsSince(wallet: LiveWallet, sinceMs: number): RelayRequest[] {
    return this.relayRequests.filter((r) => r.page === wallet.name && r.at >= sinceMs);
  }

  private watchRelay(name: string, page: Page): void {
    page.on('websocket', (socket) => {
      socket.on('framesent', ({ payload }) => {
        if (typeof payload !== 'string' || !payload.startsWith('["REQ"')) return;
        try {
          const frame = JSON.parse(payload) as unknown[];
          for (const filter of frame.slice(2) as { kinds?: number[]; '#p'?: string[] }[]) {
            this.relayRequests.push({ page: name, at: Date.now(), kinds: filter.kinds ?? [], p: filter['#p'] ?? [] });
          }
        } catch {
          /* not a JSON REQ frame */
        }
      });
    });
  }

  private async load(name: WalletName, options: { phraseOf?: WalletName; backendUrl?: string } = {}): Promise<void> {
    const profile = privateDir(join(profilesDir(), name));
    const dist = extensionDist();
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: 'chromium',
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    try {
      for (const page of context.pages()) this.watchRelay(name, page);
      context.on('page', (page) => this.watchRelay(name, page));
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
      const extensionId = new URL(worker.url()).host;
      const page = context.pages()[0] ?? (await context.newPage());
      const words = readWalletPhrase(walletFilePath(), WALLET_VARIABLES[(options.phraseOf ?? name) as 'alice' | 'bob' | 'carol']);
      let password = '';
      try {
        password = derivePassword(name, words);
        this.footage.registerSecret(password);
        this.footage.registerPhraseWords(words);
        await page.goto(`chrome-extension://${extensionId}/popup.html`);
        const state = await popupState(page);
        // A kept profile (a restarted worker, or a rescue run) unlocks; a new one imports.
        if (state === 'onboarding') await importWallet(page, words, password);
        else if (state === 'locked') await unlockExisting(page, password);
        else await waitForBalances(page);
      } finally {
        words.fill('');
      }
      passwords.set(name, password);
      if (options.backendUrl) {
        await switchBackend(page, options.backendUrl);
        await page.goto(`chrome-extension://${extensionId}/popup.html`);
        const state = await popupState(page);
        if (state === 'locked') await unlockExisting(page, password);
        await waitForBalances(page);
      }
      await maximizeAutoLock(page);
      const identity = await readIdentity(page);
      this.wallets.set(name, {
        name,
        context,
        page,
        extensionId,
        pubkeyHex: identity.pubkeyHex,
        npub: identity.npub,
        shortNpub: shortNpubFromHex(identity.pubkeyHex),
        handle: identity.handle,
      });
    } catch (error) {
      passwords.delete(name);
      await context.close().catch(() => undefined);
      // Names only: a setup failure may have happened on a phrase screen.
      throw new Error(`${name} setup failed: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`);
    }
  }

  /**
   * Stop recording and close the browsers. Profiles are never deleted here: a
   * restarted worker reopens them, and the run's global teardown deletes them
   * only once every ledger tip is settled.
   */
  async close(): Promise<void> {
    let failure: unknown = null;
    try {
      await this.footage.close();
    } catch (error) {
      failure = error;
    }
    for (const wallet of this.wallets.values()) await wallet.context.close().catch(() => undefined);
    for (const name of this.wallets.keys()) passwords.delete(name);
    this.wallets.clear();
    this.links.clear();
    if (failure) throw failure;
  }
}

/**
 * The C-tips live test: `tipLane` is worker-scoped, so both C-tips spec files
 * share one set of wallets. Specs must skip on liveGateReason() first, so a
 * closed gate never launches a browser or reads the custody file.
 */
export const test = base.extend<object, { tipLane: TipLane }>({
  tipLane: [
    async ({}, use) => {
      const lane = await TipLane.open();
      try {
        await use(lane);
      } finally {
        await lane.close();
      }
    },
    { scope: 'worker', timeout: 60 * 60_000 },
  ],
});

export { expect };
