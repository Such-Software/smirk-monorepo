/**
 * Live wallets for the G-premium lane: the hash-verified release candidate,
 * the owner's demo wallets, and the guarded recorder, shared by every test in
 * the worker so each wallet is imported once per run.
 *
 * Custody. A phrase is read in-process by the reviewed demo-lane reader
 * (`readWalletPhrase` in demo/capture-demo.mjs): exactly one NAME=value line
 * from an owner-only 0600 file, refusing symlinks, other owners and anything
 * that is not a 12 or 24 word phrase. The file is never sourced into the
 * environment, so no child process (browsers included) inherits a phrase. The
 * words are typed into the import wizard under a redaction card, registered
 * with the canary as salted word-triple hashes, then zeroed. Each wallet gets a
 * random password that stays in this process. Profiles live in a 0700 scratch
 * directory that is deleted at the end of the run.
 *
 * Environment (all names, no values):
 *   E2E_LIVE=1          the live lane; without it the spec declares no tests
 *   EXTENSION_DIST      the unpacked release candidate (checked by global setup)
 *   LIVE_EXPECT_VERSION manifest version to insist on (default 0.3.1)
 *   LIVE_WALLET_FILE    custody file (default: packages/smoke-tests/secrets/smoke-mnemonics.env)
 *   FOOTAGE=guarded     record through the guarded recorder
 *   FOOTAGE_DIR         footage root (default ~/Build/smirk-e2e/v0.3.1-run-11204/footage)
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { test as base } from './private-test.js';
import { assertPrivateCapture } from '../capture-policy.mjs';
import { GuardedFootage, footageRequested } from './G-premium-footage.js';
import { watchContext } from './failure-context.js';

const here = dirname(fileURLToPath(import.meta.url));

export const LIVE = process.env.E2E_LIVE === '1';
export const EXPECT_VERSION = process.env.LIVE_EXPECT_VERSION ?? '0.3.1';
const EXTENSION_DIST = process.env.EXTENSION_DIST ?? join(here, '..', '..', 'extension', 'dist');
const WALLET_FILE = process.env.LIVE_WALLET_FILE
  ?? resolve(here, '..', '..', 'smoke-tests', 'secrets', 'smoke-mnemonics.env');

export type WalletName = 'alice' | 'bob' | 'carol';
const VARIABLE: Readonly<Record<WalletName, string>> = {
  alice: 'SMOKE_ALICE_MNEMONIC',
  bob: 'SMOKE_BOB_MNEMONIC',
  carol: 'SMOKE_CAROL_MNEMONIC',
};
export const WALLET_NAMES: readonly WalletName[] = ['alice', 'bob', 'carol'];

/**
 * A rate-limited restore check is retried after this long, this many times
 * (half an hour in all): the backend's window is a rolling hour per address.
 */
const RATE_LIMIT_WAIT_MS = 5 * 60_000;
const RATE_LIMIT_WAITS = 6;

/** Popup-sized pages at device pixels, the same frame as the demo lane. */
const VIEWPORT = { width: 380, height: 600 } as const;
const SCALE = 2;

type ReadWalletPhrase = (file: string, variable: string) => string[];

/**
 * The reviewed custody reader, loaded at run time. The module has no type
 * declarations; a computed specifier keeps this lane from adding one beside a
 * shared file.
 */
async function custodyReader(): Promise<ReadWalletPhrase> {
  const specifier = new URL('../demo/capture-demo.mjs', import.meta.url).href;
  const loaded = (await import(specifier)) as { readWalletPhrase?: unknown };
  if (typeof loaded.readWalletPhrase !== 'function') throw new Error('demo/capture-demo.mjs no longer exports readWalletPhrase');
  return loaded.readWalletPhrase as ReadWalletPhrase;
}

/**
 * A refusal this lane recognised. Its message is static text plus, at most,
 * the wallet's own on-screen words after the canary has cleared them, so it
 * may be printed where Playwright's own error text may not.
 */
class LaneRefusal extends Error {}

/**
 * The extension opens its setup tab (`popup.html?ctx=tab`) on install. It is
 * not part of any scenario, so it is closed before the recorder watches the
 * context and never gets a window lane. It opens within moments of install;
 * a build that opens none costs this bounded wait once per wallet.
 */
async function closeSetupTab(context: BrowserContext, main: Page): Promise<void> {
  const isSetup = (other: Page) => other !== main && /\/popup\.html\?ctx=tab\b/.test(other.url());
  await expect.poll(() => context.pages().some(isSetup), { timeout: 15_000 }).toBe(true).catch(() => undefined);
  for (const other of context.pages()) {
    if (isSetup(other)) await other.close().catch(() => {});
  }
}

export class LiveWallet {
  readonly name: WalletName;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly extensionId: string;
  readonly #footage: GuardedFootage;
  #password: string;

  constructor(name: WalletName, context: BrowserContext, page: Page, extensionId: string, password: string, footage: GuardedFootage) {
    this.name = name;
    this.context = context;
    this.page = page;
    this.extensionId = extensionId;
    this.#password = password;
    this.#footage = footage;
  }

  get popupUrl(): string {
    return `chrome-extension://${this.extensionId}/popup.html`;
  }

  /** Unlock a wallet window on its lock screen, under a redaction card. */
  async unlock(page: Page): Promise<void> {
    await this.#footage.secret('Unlocking the wallet', async () => {
      await page.getByTestId('lockscreen-password-input').fill(this.#password);
      await page.getByTestId('lockscreen-unlock-btn').click();
      await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 120_000 });
    });
  }

  /** Answer the operation-password dialog under a redaction card. */
  async confirmOperationPassword(page: Page): Promise<void> {
    await this.#footage.secret('Confirming with the wallet password', async () => {
      await page.getByTestId('operation-password').fill(this.#password);
      await page.getByTestId('operation-password-confirm').click();
      await expect(page.getByTestId('operation-password')).toHaveCount(0, { timeout: 60_000 });
    });
  }

  /**
   * Another window of this wallet. A new window opens on the lock screen
   * unless a grace period restores it; either way it ends unlocked.
   */
  async openWindow(name: string): Promise<Page> {
    const page = await this.context.newPage();
    this.#footage.attach(page, { name, wallet: this.name, role: 'secondary' });
    await page.goto(this.popupUrl);
    const lock = page.getByTestId('lockscreen-password-input');
    const home = page.getByTestId('bottom-nav');
    await expect(lock.or(home)).toBeVisible({ timeout: 120_000 });
    if (await lock.isVisible()) await this.unlock(page);
    await expect(home).toBeVisible({ timeout: 120_000 });
    return page;
  }

  forget(): void {
    this.#password = '';
  }
}

export class LiveWallets {
  readonly #footage: GuardedFootage;
  readonly #scratch: string;
  readonly #open = new Map<WalletName, Promise<LiveWallet>>();
  #reader: Promise<ReadWalletPhrase> | undefined;

  constructor(footage: GuardedFootage) {
    this.#footage = footage;
    this.#scratch = mkdtempSync(join(tmpdir(), 'smirk-G-premium-'));
    chmodSync(this.#scratch, 0o700);
  }

  /** The wallet, imported on first use and kept for the rest of the run. */
  get(name: WalletName): Promise<LiveWallet> {
    let wallet = this.#open.get(name);
    if (!wallet) {
      wallet = this.#importWallet(name);
      this.#open.set(name, wallet);
    }
    return wallet;
  }

  async #importWallet(name: WalletName): Promise<LiveWallet> {
    if (!existsSync(join(EXTENSION_DIST, 'manifest.json'))) {
      throw new Error('EXTENSION_DIST must point at the unpacked release candidate.');
    }
    const manifest = JSON.parse(readFileSync(join(EXTENSION_DIST, 'manifest.json'), 'utf8')) as { version?: string };
    if (manifest.version !== EXPECT_VERSION) {
      throw new Error(`The extension under test is ${manifest.version ?? 'unversioned'}, not the ${EXPECT_VERSION} release candidate.`);
    }
    if (!existsSync(WALLET_FILE)) {
      throw new Error('Wallet custody file not found. Set LIVE_WALLET_FILE to the owner-only custody file in the main checkout.');
    }
    this.#reader ??= custodyReader();
    const read = await this.#reader;

    const profile = mkdtempSync(join(this.#scratch, `${name}-`));
    chmodSync(profile, 0o700);
    const context = await chromium.launchPersistentContext(profile, {
      headless: !process.env.HEADED,
      channel: 'chromium',
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      args: [`--disable-extensions-except=${EXTENSION_DIST}`, `--load-extension=${EXTENSION_DIST}`],
    });
    // Request shapes and screen test ids for the private failure log; no values.
    watchContext(name, context);
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    this.#footage.attach(page, { name, wallet: name, role: 'main' });
    await closeSetupTab(context, page);
    // Only now: the setup tab must never get a window lane of its own.
    this.#footage.watch(context, name);
    const password = randomBytes(24).toString('base64url');
    this.#footage.canary.addValue(password);

    // The suite's reporter withholds error text and its config silences test
    // output, so a failed import records which stage it reached, and a refusal
    // the lane recognised records why in the wizard's own words once the
    // canary has cleared them, in the run's private evidence (and on stderr).
    let stage = 'opening the import wizard';
    try {
      await this.#footage.secret('Importing a demo wallet', () => this.#runImport(name, page, extensionId, password, read, (next) => {
        stage = next;
      }));
    } catch (error) {
      const said = error instanceof LaneRefusal ? error.message : null;
      this.#footage.evidence(`import_${name}_stopped_while`, stage);
      if (said) this.#footage.evidence(`import_${name}_refusal`, said);
      process.stderr.write(`G-premium: importing ${name} stopped while ${stage}.${said ? ` ${said}` : ''}\n`);
      throw error;
    }
    // Anything else still open (the persistent context's first blank page, a
    // setup tab that opened late) is not part of any scenario either; a
    // recorded one ends its window lane here.
    for (const other of context.pages()) {
      if (other !== page) await other.close().catch(() => {});
    }
    return new LiveWallet(name, context, page, extensionId, password, this.#footage);
  }

  /** The import wizard, run inside the caller's secret scope. */
  async #runImport(
    name: WalletName,
    page: Page,
    extensionId: string,
    password: string,
    read: ReadWalletPhrase,
    at: (stage: string) => void,
  ): Promise<void> {
    at('entering the recovery phrase');
    const words = read(WALLET_FILE, VARIABLE[name]);
    this.#footage.canary.addPhrase(words);
    try {
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      await page.getByTestId('onboarding-import-btn').click();
      await page.getByTestId('onboarding-import-warning-continue').click();
      for (let i = 0; i < words.length; i++) await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i]!);
    } finally {
      words.fill('');
    }
    await page.getByTestId('onboarding-import-continue').click();
    at('setting the wallet password');
    // The wizard fails closed until the backend's sign-up requirements
    // resolve; its retry rebuilds the step with empty fields. Retry only that
    // race and a rate-limited history check below, which the backend does not
    // count: any other refusal could spend the wallet's restore budget.
    const submit = page.getByTestId('onboarding-set-password-submit');
    const first = page.getByTestId('onboarding-password-input');
    // "Couldn't reach the backend to check its sign-up requirements", or the
    // step's own check failing because a rebuild emptied the fields under us.
    const notYet = page.getByText(/sign-up requirements|Password must be at least|Passwords don't match/);
    const answer = async (): Promise<'moved' | 'not-yet' | null> => {
      if (!(await submit.isVisible().catch(() => false))) return 'moved';
      return (await notYet.isVisible().catch(() => false)) ? 'not-yet' : null;
    };
    const submitPassword = async (): Promise<void> => {
      for (let attempt = 0; attempt < 4; attempt++) {
        await first.fill(password);
        await page.getByTestId('onboarding-password-confirm-input').fill(password);
        // A refusal from the last try stays on screen until the step moves on,
        // so after one, only a step that has not moved in 30 s is refused again.
        const stale = await notYet.isVisible().catch(() => false);
        await submit.click();
        if (stale) await submit.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
        // Wait for the wizard's answer, however slowly the requirements or a
        // returning-wallet check resolve: the step moves on, or it says it cannot yet.
        await expect.poll(answer, {
          timeout: 3 * 60_000,
          message: `${name}'s import never left the password step and never said why`,
        }).not.toBeNull();
        if ((await answer()) === 'moved') return;
        // The wizard re-reads the requirements now, backing off for a few
        // seconds, and may rebuild the step empty: let that happen first.
        await expect.poll(async () => (await first.inputValue().catch(() => '')) === '', { timeout: 10_000 })
          .toBe(true).catch(() => undefined);
      }
      throw new LaneRefusal('The wizard could not read the backend sign-up requirements after four tries.');
    };
    // Registration runs after the step moves on; a refusal brings the
    // password step back with the wizard's reason, instead of Home.
    const finish = page.getByTestId('onboarding-setup-finish-btn');
    const home = page.getByTestId('home-total-balance');
    for (let wait = 0; ; wait++) {
      at('setting the wallet password');
      await submitPassword();
      at('registering with the backend');
      await expect(finish.or(home).or(submit), `${name}'s registration never finished`).toBeVisible({ timeout: 10 * 60_000 });
      if (!(await submit.isVisible())) break;
      const said = ((await submit.locator('xpath=preceding-sibling::div[1]').textContent({ timeout: 2_000 }).catch(() => null)) ?? '')
        .replace(/\s+/g, ' ').trim().slice(0, 160);
      // Every import asks /auth/check-restore, which the backend allows 30
      // times an hour per client address; parallel lanes on one machine share
      // that budget. A refused check is not counted, so waiting it out is free.
      if (/rate limited/i.test(said) && wait < RATE_LIMIT_WAITS) {
        this.#footage.evidence(`import_${name}_rate_limit_waits`, wait + 1);
        at('waiting out the backend restore rate limit');
        await page.waitForTimeout(RATE_LIMIT_WAIT_MS);
        continue;
      }
      const reason = said && !this.#footage.canary.hit(said, []) ? `"${said}"` : 'a reason the canary withheld';
      throw new LaneRefusal(`The backend refused the registration; the wizard said ${reason}.`);
    }
    if (await finish.isVisible()) await finish.click({ timeout: 60_000 });
    // Proof-of-work may be on: allow a slow first registration.
    at('waiting for Home and a real balance');
    const total = page.getByTestId('home-total-balance');
    await expect(total).toBeVisible({ timeout: 10 * 60_000 });
    await expect.poll(async () => (await total.textContent())?.trim() ?? '', {
      timeout: 5 * 60_000,
      message: `${name} never loaded a real balance, so the backend never authenticated it`,
    }).toMatch(/\d/);
  }

  async close(): Promise<void> {
    for (const pending of this.#open.values()) {
      const wallet = await pending.catch(() => null);
      if (!wallet) continue;
      wallet.forget();
      await wallet.context.close().catch(() => {});
    }
    this.#open.clear();
    rmSync(this.#scratch, { recursive: true, force: true });
  }
}

/** Worker-scoped: one recorder and one import per wallet for the whole run. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no test-scoped fixtures
export const test = base.extend<{}, { footage: GuardedFootage; live: LiveWallets }>({
  footage: [async ({}, use) => {
    assertPrivateCapture();
    const footage = new GuardedFootage({ recording: footageRequested() });
    try {
      await use(footage);
    } finally {
      await footage.close();
    }
  }, { scope: 'worker', timeout: 5 * 60_000 }],
  live: [async ({ footage }, use) => {
    const wallets = new LiveWallets(footage);
    try {
      await use(wallets);
    } finally {
      await wallets.close();
    }
  }, { scope: 'worker', timeout: 5 * 60_000 }],
});

export { expect };
