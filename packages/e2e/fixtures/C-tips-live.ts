/**
 * C-tips live lane: alice, bob and carol imported once per worker into three
 * persistent Chromium profiles of the release build under test, recorded by the
 * guarded footage recorder.
 *
 * Gates, each its own explicit opt-in (closed by default):
 *   E2E_LIVE=1          drive the backend under test with the demo wallets
 *   E2E_LIVE_MONEY=1    move real funds (small amounts, among the three)
 *   ALLOW_PROD_WRITES=1 required when BACKEND_URL is a shared host
 *   FOOTAGE=guarded     record (optional; off records nothing and skips holds)
 *
 * Custody: each phrase is read in-process through readWalletPhrase from the
 * owner-only file named by SMOKE_WALLET_FILE. The file is never sourced into
 * the environment, so no browser or child process inherits a phrase. Phrases
 * are typed only into the unrecorded setup page, then zeroed; each wallet gets
 * a random password that lives only in this module's memory. Profiles live in
 * a 0700 scratch directory and are deleted at the end.
 */
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex, decodeNpub, encodeNpub, hexToBytes, shortNpub } from '@smirk/core';
import { test as base } from './private-test.js';
import { BACKEND_URL, isSharedBackend } from './extension.js';
import { WALLET_VARIABLES, readWalletPhrase, walletFileExists, walletFilePath } from './C-tips-custody.mjs';
import { DEVICE_SCALE, GuardedFootage, VIEWPORT, footageMode } from './C-tips-footage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The release build under test: the unpacked staged Chrome zip for a release run. */
export const EXTENSION_DIST = process.env.EXTENSION_DIST ?? join(__dirname, '..', '..', 'extension', 'dist');

export type WalletName = 'alice' | 'bob' | 'carol';
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

/** Why the live lane must not run here, or null when every gate is open. */
export function liveGateReason(env: Record<string, string | undefined> = process.env): string | null {
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
  if (!existsSync(join(EXTENSION_DIST, 'manifest.json'))) {
    return `no extension build at ${EXTENSION_DIST}: set EXTENSION_DIST to the unpacked release build`;
  }
  try {
    footageMode(env);
  } catch (error) {
    return error instanceof Error ? error.message : 'FOOTAGE is not a recognized mode';
  }
  return null;
}

export function shortNpubFromHex(pubkeyHex: string): string {
  return shortNpub(encodeNpub(hexToBytes(pubkeyHex)));
}

function scratchRoot(): string {
  const root = (process.env.E2E_PROFILE_DIR ?? '').trim() || join(tmpdir(), 'smirk-e2e-profiles');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

/** Tapping a tab restores its last sub-screen; tapping again returns to its root. */
async function setupTabRoot(page: Page, tab: string): Promise<void> {
  await page.getByTestId(`nav-tab-${tab}`).click();
  await page.getByTestId(`nav-tab-${tab}`).click();
}

/**
 * Import one wallet on a page nothing records. Mirrors the reviewed demo lane's
 * setup, including the capabilities-race retry, then sets auto-lock to its
 * maximum so hours of confirmation waits do not lock the wallet mid-scenario.
 */
async function importWallet(page: Page, extensionId: string, words: string[], password: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByTestId('onboarding-import-btn').click({ timeout: 60_000 });
  await page.getByTestId('onboarding-import-warning-continue').click();
  for (let i = 0; i < words.length; i++) await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i]!);
  await page.getByTestId('onboarding-import-continue').click();
  const submit = page.getByTestId('onboarding-set-password-submit');
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByTestId('onboarding-password-input').fill(password);
    await page.getByTestId('onboarding-password-confirm-input').fill(password);
    await submit.click();
    await page.waitForTimeout(3_000);
    if (!(await submit.isVisible().catch(() => false))) break;
    // Retry only the capabilities race: every other refusal would spend the
    // backend's per-wallet restore budget.
    const screen = await page.locator('#root').innerText();
    if (!/sign-up requirements/.test(screen)) break;
    await page.waitForTimeout(5_000);
  }
  await page.getByTestId('onboarding-setup-finish-btn').click({ timeout: 25_000 }).catch(() => undefined);
  const total = page.getByTestId('home-total-balance');
  await total.waitFor({ timeout: 10 * 60_000 });
  await expect
    .poll(async () => /\d/.test((await total.textContent()) ?? ''), {
      timeout: 5 * 60_000,
      message: 'the wallet never loaded a real balance set from the backend',
    })
    .toBe(true);
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

async function readIdentity(page: Page): Promise<{ pubkeyHex: string; npub: string; handle: string | null }> {
  await setupTabRoot(page, 'settings');
  await page.getByTestId('settings-nostr-nav').click();
  await page.getByTestId('settings-nostr-screen').waitFor({ timeout: 30_000 });
  const npubText = ((await page.getByTestId('nostr-npub').textContent({ timeout: 30_000 })) ?? '').trim();
  const npub = npubText.match(/npub1[02-9ac-hj-np-z]{58}/)?.[0];
  if (!npub) throw new Error('the active Nostr identity did not render an npub');
  const handleBox = page.getByTestId('nostr-handle');
  await handleBox.or(page.getByTestId('nostr-handle-absent')).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  let handle: string | null = null;
  if (await handleBox.isVisible().catch(() => false)) {
    // The box's spans read "Your Smirk handle", "<name>@<domain>", then the link state.
    const shown = ((await handleBox.locator('span').nth(1).textContent()) ?? '').trim();
    const name = shown.match(/^([a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,})$/i)?.[1];
    // Only a handle linked to this identity resolves to it.
    if (name && /verified/i.test((await handleBox.textContent()) ?? '')) handle = name.toLowerCase();
  }
  return { pubkeyHex: bytesToHex(decodeNpub(npub)), npub, handle };
}

export class TipLane {
  readonly footage = new GuardedFootage();
  readonly wallets = new Map<WalletName, LiveWallet>();
  private readonly profiles: string[] = [];

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
      for (const wallet of lane.wallets.values()) {
        await setupTabRoot(wallet.page, 'home');
        await wallet.page.getByTestId('home-total-balance').waitFor({ timeout: 60_000 });
        lane.footage.attach(wallet.name, wallet.page);
        wallet.context.on('page', (page) => lane.footage.attach(`${wallet.name}-tab`, page));
      }
      return lane;
    } catch (error) {
      await lane.close().catch(() => undefined);
      throw error;
    }
  }

  private async load(name: WalletName): Promise<void> {
    const profile = mkdtempSync(join(scratchRoot(), `c-tips-${name}-`));
    chmodSync(profile, 0o700);
    this.profiles.push(profile);
    const context = await chromium.launchPersistentContext(profile, {
      headless: !process.env.HEADED,
      channel: 'chromium',
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE,
      args: [`--disable-extensions-except=${EXTENSION_DIST}`, `--load-extension=${EXTENSION_DIST}`],
    });
    try {
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
      const extensionId = new URL(worker.url()).host;
      const page = context.pages()[0] ?? (await context.newPage());
      const password = randomBytes(24).toString('base64url');
      this.footage.registerSecret(password);
      const words = readWalletPhrase(walletFilePath(), WALLET_VARIABLES[name]);
      this.footage.registerPhraseWords(words);
      try {
        await importWallet(page, extensionId, words, password);
      } finally {
        words.fill('');
      }
      await maximizeAutoLock(page);
      const identity = await readIdentity(page);
      const wallet: LiveWallet = {
        name,
        context,
        page,
        extensionId,
        pubkeyHex: identity.pubkeyHex,
        npub: identity.npub,
        shortNpub: shortNpubFromHex(identity.pubkeyHex),
        handle: identity.handle,
      };
      passwords.set(name, password);
      this.wallets.set(name, wallet);
    } catch (error) {
      await context.close().catch(() => undefined);
      // Names only: a setup failure may have happened on a phrase screen.
      throw new Error(`${name} setup failed: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`);
    }
  }

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
    for (const profile of this.profiles) rmSync(profile, { recursive: true, force: true });
    if (failure) throw failure;
  }
}

/**
 * The C-tips live test: `tipLane` is worker-scoped, so both C-tips spec files
 * share one import of each wallet. Specs must skip on liveGateReason() first,
 * so a closed gate never launches a browser or reads the custody file.
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
    { scope: 'worker', timeout: 45 * 60_000 },
  ],
});

export { expect };
