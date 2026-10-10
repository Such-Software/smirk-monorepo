/**
 * Demo wallets for the E-swaps live lane.
 *
 * Custody: each phrase is read in-process from exactly one `NAME=value` line
 * of the owner-only custody file (default
 * packages/smoke-tests/secrets/smoke-mnemonics.env in the main checkout;
 * worktrees name it with E2E_WALLET_FILE). The file is never sourced into the
 * environment, so no child process (the browser included) inherits it. The
 * phrase goes into the import fields and is then zeroed; only hashes of its
 * three-word runs stay, for the footage canary.
 *
 * Each wallet gets its own persistent Chromium profile in a 0700 scratch
 * directory, removed at the end, and a random password that never leaves this
 * process: specs unlock and confirm through methods here and never see it.
 *
 * Recording: the first page's recorder starts on Home, after the import and
 * unlock and two clean guard passes. The import itself is a redaction card in
 * the timeline and is never captured. A reopened popup records from its lock
 * screen, whose password field is always masked and typed into only inside a
 * secret scope (recorder paused).
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type BrowserContext, type Dialog, type Locator, type Page } from '@playwright/test';
import { Canary, PageRecorder, WalletFootage, WalletTimeline } from './E-swaps-footage.js';

export type WalletName = 'alice' | 'bob' | 'carol';
export const WALLET_NAMES: readonly WalletName[] = ['alice', 'bob', 'carol'];

/** Popup-sized viewport, as the demo lane records it. */
const VIEWPORT = { width: 380, height: 600 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Probe until it returns a value or `timeoutMs` passes (then null). A probe
 * that throws counts as "not yet". Probes must not wait on their own.
 */
export async function pollUntil<T>(probe: () => Promise<T | null>, timeoutMs: number, intervalMs = 250): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/** Read exactly one NAME=value line from an owner-only file; never print it. */
export function readWalletPhrase(file: string, variable: string): string[] {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('wallet custody file must be a regular owner-only (0600) file owned by this user');
  }
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=\\s*(.*)$`);
  const matches = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.match(pattern))
    .filter((m): m is RegExpMatchArray => m !== null);
  if (matches.length !== 1) throw new Error(`expected exactly one ${variable} assignment in the wallet custody file`);
  const phrase = (matches[0]![1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const words = phrase.split(/\s+/);
  if (![12, 24].includes(words.length) || words.some((word) => !/^[a-z]+$/.test(word))) {
    throw new Error(`${variable} is not a 12- or 24-word phrase`);
  }
  return words;
}

/** One host and path the page asked for. Query strings are never kept. */
export interface RequestEntry {
  at: number;
  method: string;
  host: string;
  path: string;
}

/** Requests made by one wallet page from `start()` on. */
export class RequestLog {
  readonly entries: RequestEntry[] = [];
  private readonly listener = (request: { url(): string; method(): string }) => {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    this.entries.push({ at: Date.now(), method: request.method(), host: url.host, path: url.pathname });
  };

  constructor(private readonly page: Page) {
    page.on('request', this.listener);
  }

  stop(): void {
    this.page.off('request', this.listener);
  }

  hosts(since = 0): string[] {
    return [...new Set(this.entries.filter((e) => e.at >= since).map((e) => e.host))].sort();
  }
}

export class LiveWallet {
  readonly canary = new Canary();
  readonly footage: WalletFootage;
  private currentPage!: Page;
  private recorder!: PageRecorder;
  private readonly acceptPatterns = new Set<RegExp>();

  private constructor(
    readonly name: WalletName,
    readonly context: BrowserContext,
    readonly extensionId: string,
    private readonly password: string,
    private readonly timeline: WalletTimeline,
    private readonly profileDir: string,
  ) {
    this.footage = new WalletFootage(timeline, this.canary, () => ({ page: this.currentPage, recorder: this.recorder }));
    // Accept the Send-draft replacement prompt: a swap deposit replacing a
    // stale test draft is intended. Anything else is dismissed unless a
    // spec opts in for that one prompt.
    this.acceptPatterns.add(/replace it with this swap deposit/);
  }

  /** The wallet's current popup page. Replaced by `reopen()`. */
  get page(): Page {
    return this.currentPage;
  }

  get popupUrl(): string {
    return `chrome-extension://${this.extensionId}/popup.html`;
  }

  /**
   * Launch a profile with the extension, import the phrase and wait for a
   * real balance. The import is a redaction card; frames start on Home.
   */
  static async open(opts: {
    name: WalletName;
    extensionDir: string;
    walletFile: string;
    timelineDir: string;
    runId: string;
    record: boolean;
    scratchRoot?: string;
  }): Promise<LiveWallet> {
    const variable = `SMOKE_${opts.name.toUpperCase()}_MNEMONIC`;
    const words = readWalletPhrase(opts.walletFile, variable);
    const profileDir = mkdtempSync(join(opts.scratchRoot ?? tmpdir(), `smirk-e2e-E-swaps-${opts.name}-`));
    let context: BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: !process.env.HEADED,
        channel: 'chromium',
        viewport: VIEWPORT,
        deviceScaleFactor: 2,
        args: [`--disable-extensions-except=${opts.extensionDir}`, `--load-extension=${opts.extensionDir}`],
      });
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
      const extensionId = new URL(worker.url()).host;
      const timeline = new WalletTimeline(opts.timelineDir, opts.name, opts.runId, opts.record);
      const wallet = new LiveWallet(opts.name, context, extensionId, randomBytes(24).toString('base64url'), timeline, profileDir);
      wallet.canary.addPhrase(words);
      wallet.canary.addLiteral(wallet.password);
      const page = await context.newPage();
      wallet.attach(page, { record: false });
      await wallet.footage.secret('wallet import and unlock', async () => {
        await page.goto(wallet.popupUrl);
        await wallet.importPhrase(page, words);
      });
      // Home is showing and two guard passes found it clean: record from here.
      wallet.recorder.start();
      await wallet.footage.settled('wallet ready on Home');
      return wallet;
    } catch (error) {
      words.fill('');
      await context?.close().catch(() => {});
      rmSync(profileDir, { recursive: true, force: true });
      throw error;
    } finally {
      words.fill('');
    }
  }

  private attach(page: Page, options: { record: boolean }): void {
    this.currentPage = page;
    // One popup page per wallet at a time; a reopened popup continues the
    // same column. Pages the app opens itself (provider links) are never
    // opened by these specs, so they are not recorded.
    this.recorder = new PageRecorder(page, 'main', this.timeline, this.canary);
    if (options.record) this.recorder.start();
    page.on('dialog', (dialog: Dialog) => {
      const accept = [...this.acceptPatterns].some((pattern) => pattern.test(dialog.message()));
      void (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });
  }

  /** Accept the next prompts matching `pattern` until `release` is called. */
  acceptDialogs(pattern: RegExp): () => void {
    this.acceptPatterns.add(pattern);
    return () => this.acceptPatterns.delete(pattern);
  }

  startRequestLog(): RequestLog {
    return new RequestLog(this.currentPage);
  }

  /** Never printed: only a value the canary watches for. `publicParts` are shown openly anyway. */
  watchSecret(value: string, publicParts: readonly string[] = []): void {
    this.canary.addLiteral(value, publicParts);
  }

  /**
   * Import inside the caller's secret scope. Every wait is for a state of the
   * screen, never a fixed time.
   */
  private async importPhrase(page: Page, words: string[]): Promise<void> {
    await page.getByTestId('onboarding-import-btn').click({ timeout: 60_000 });
    await page.getByTestId('onboarding-import-warning-continue').click({ timeout: 30_000 });
    for (let i = 0; i < words.length; i++) await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i]!, { timeout: 30_000 });
    await page.getByTestId('onboarding-import-continue').click({ timeout: 30_000 });
    const submit = page.getByTestId('onboarding-set-password-submit');
    const first = page.getByTestId('onboarding-password-input');
    const requirements = page.getByText(/sign-up requirements/).first();
    // The wizard fails closed until the backend's sign-up requirements
    // resolve, and its retry re-reads them. Retry only that refusal: any other
    // would spend the wallet's restore budget.
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1 && !(await submit.isVisible())) break;
      await first.fill(this.password, { timeout: 30_000 });
      await page.getByTestId('onboarding-password-confirm-input').fill(this.password, { timeout: 10_000 });
      await submit.click({ timeout: 10_000 });
      const outcome = await pollUntil(async () => {
        if (!(await submit.isVisible())) return 'moved on' as const;
        if (await requirements.isVisible()) return 'requirements' as const;
        return null;
      }, 60_000);
      if (outcome === 'moved on') break;
      if (outcome === null) throw new Error('the password step neither moved on nor said why within a minute');
      if (attempt >= 4) throw new Error('the backend sign-up requirements never resolved after four tries');
      // Wait for the re-read to rebuild the step (its fields empty or its
      // message gone) before trying again.
      await pollUntil(async () => {
        if (!(await requirements.isVisible())) return true;
        return (await first.inputValue({ timeout: 1_000 })) === '' ? true : null;
      }, 30_000);
    }
    // An optional setup step, or Home. Restore proof of work may run first.
    const finish = page.getByTestId('onboarding-setup-finish-btn');
    const total = page.getByTestId('home-total-balance');
    const next = await pollUntil(async () => {
      if (await finish.isVisible()) return 'setup' as const;
      if (await total.isVisible()) return 'home' as const;
      return null;
    }, 10 * 60_000, 500);
    if (next === null) throw new Error('neither the setup step nor Home appeared after the import');
    if (next === 'setup') await finish.click({ timeout: 30_000 });
    await total.waitFor({ timeout: 10 * 60_000 });
    await expect
      .poll(async () => (await total.textContent())?.trim() ?? '', {
        timeout: 5 * 60_000,
        message: 'the wallet never loaded a real balance set from the backend',
      })
      .toMatch(/\d/);
  }

  /**
   * Close the popup page and open a new one, as a user reopening the popup.
   * The lock screen's password is typed inside a secret scope.
   */
  async reopen(): Promise<void> {
    await this.footage.settleIfUnheld();
    this.footage.mark('popup closed');
    const old = { page: this.currentPage, recorder: this.recorder };
    await old.recorder.stop();
    await old.page.close();
    const page = await this.context.newPage();
    this.attach(page, { record: true });
    await page.goto(this.popupUrl);
    const lock = page.getByTestId('lockscreen-root');
    const nav = page.getByTestId('bottom-nav');
    await expect(lock.or(nav).first()).toBeVisible({ timeout: 60_000 });
    await this.footage.settled('popup reopened');
    if (await lock.isVisible()) {
      await this.footage.secret('unlock with the wallet password', async () => {
        await page.getByTestId('lockscreen-password-input').fill(this.password);
        await page.getByTestId('lockscreen-unlock-btn').click();
        await lock.waitFor({ state: 'detached', timeout: 120_000 });
      });
    }
    await expect(nav).toBeVisible({ timeout: 60_000 });
  }

  /**
   * After a tap that may ask for the operation password (when the owner has
   * turned on "require password for sends"), wait until `done` shows,
   * answering the prompt in a secret scope whenever it appears, early or
   * late. Returns how many times the prompt was answered.
   */
  async untilShownAnsweringPassword(done: Locator, timeoutMs: number): Promise<number> {
    const prompt = this.currentPage.getByTestId('operation-password');
    const deadline = Date.now() + timeoutMs;
    let answered = 0;
    while (Date.now() < deadline) {
      if (await done.isVisible().catch(() => false)) return answered;
      if (await prompt.isVisible().catch(() => false)) {
        if (answered >= 2) throw new Error('the operation password prompt came back after two answers');
        answered++;
        await this.footage.secret('operation password', async () => {
          await prompt.fill(this.password, { timeout: 10_000 });
          await this.currentPage.getByTestId('operation-password-confirm').click({ timeout: 10_000 });
          await prompt.waitFor({ state: 'detached', timeout: 60_000 });
        });
        continue;
      }
      await sleep(250);
    }
    throw new Error('the action never reached its result screen');
  }

  async close(): Promise<void> {
    try {
      await this.recorder.stop();
    } finally {
      this.timeline.close();
      await this.context.close().catch(() => {});
      rmSync(this.profileDir, { recursive: true, force: true });
    }
  }
}
