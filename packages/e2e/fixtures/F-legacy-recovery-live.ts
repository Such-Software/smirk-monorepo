/**
 * Live wallets for the F-legacy-recovery lane (older addresses, the move flow
 * and old-server tips) against a real backend.
 *
 * WALLET CUSTODY. The demo wallets' phrases are read in-process, one named line
 * at a time, from the owner-only custody file named by `E2E_WALLET_FILE` (the
 * same rules as `demo/capture-demo.mjs` readWalletPhrase: a regular 0600 file
 * owned by this user, exactly one assignment, 12 or 24 lowercase words). The
 * file is never sourced into the environment: that would hand the phrases to
 * every child process, browsers included, so this fixture refuses to start
 * when any SMOKE_*_MNEMONIC variable is set, and launches each browser with an
 * environment stripped of secret-looking names.
 *
 * Each wallet gets its own persistent Chromium profile under a 0700 scratch
 * directory, a random password that lives only in this process, and its own
 * footage. The words are digested into the footage canary and then blanked.
 * Profiles are deleted when the worker ends.
 *
 * NETWORK EVIDENCE. Each context records method, host, path and status of the
 * wallet page's own requests (never query strings or bodies: LWS requests carry
 * view keys). One helper reads a broadcast response for its txid only.
 */

import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base } from './private-test.js';
import { createCanary } from './F-legacy-recovery-guard.mjs';
import { WalletFootage, type FootageLabel } from './F-legacy-recovery-footage.js';

export type WalletName = 'alice' | 'bob' | 'carol';
export const WALLET_NAMES: readonly WalletName[] = ['alice', 'bob', 'carol'];
const WALLET_VARS: Record<WalletName, string> = {
  alice: 'SMOKE_ALICE_MNEMONIC',
  bob: 'SMOKE_BOB_MNEMONIC',
  carol: 'SMOKE_CAROL_MNEMONIC',
};

/** The whole lane is opt-in; without it the spec declares no tests. */
export const LIVE = process.env.E2E_LIVE === '1';
/** Moving real coins needs its own opt-in. */
export const LIVE_MONEY = process.env.E2E_LIVE_MONEY === '1';

const VIEWPORT = { width: 380, height: 600 };
const IMPORT_PATIENCE_MS = 10 * 60_000;

/** Read exactly one NAME=value phrase line from an owner-only file; never print it. */
export function readWalletPhrase(file: string, variable: string): string[] {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('wallet file must be a regular owner-only (0600) file owned by this user');
  }
  const matches = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.match(new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=\\s*(.*)$`)))
    .filter((m): m is RegExpMatchArray => m !== null);
  if (matches.length !== 1) throw new Error(`expected exactly one ${variable} assignment in the wallet file`);
  const phrase = (matches[0]?.[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const words = phrase.split(/\s+/);
  if (![12, 24].includes(words.length) || words.some((word) => !/^[a-z]+$/.test(word))) {
    throw new Error(`${variable} is not a 12- or 24-word phrase`);
  }
  return words;
}

/** Refuse a run whose environment already carries phrases. */
function assertPhrasesNotInEnvironment(): void {
  const leaked = Object.keys(process.env).filter((k) => /^SMOKE_.*MNEMONIC$/.test(k));
  if (leaked.length) {
    throw new Error(
      `refusing: ${leaked.join(', ')} is set in the environment, so every child process (browsers included) ` +
        'inherits the phrase. Unset it and pass the custody file path in E2E_WALLET_FILE instead.',
    );
  }
}

/** The browser's environment, without anything that looks like a credential. */
function browserEnvironment(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/MNEMONIC|SEED|PASSWORD|PASSPHRASE|SECRET|TOKEN|PRIVATE|CREDENTIAL|_KEY$|^E2E_WALLET_FILE$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function extensionDir(): string {
  const dir = process.env.EXTENSION_DIST;
  if (!dir) throw new Error('EXTENSION_DIST must name the unpacked release extension under test.');
  const manifestPath = join(resolve(dir), 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('EXTENSION_DIST has no manifest.json; unpack the release zip there.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
  const expected = process.env.E2E_EXPECT_VERSION ?? '0.3.1';
  if (manifest.version !== expected) {
    throw new Error(`EXTENSION_DIST is version ${manifest.version ?? 'unknown'}, expected ${expected}.`);
  }
  return resolve(dir);
}

/** Method, host, path and status of one response. Never a query or a body. */
export interface NetEvent {
  method: string;
  host: string;
  path: string;
  status: number;
  at: number;
}

export interface LiveWallet {
  readonly name: WalletName;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly extensionId: string;
  readonly footage: WalletFootage;
  /** Responses seen by this wallet's pages since `since` (ms epoch). */
  responses(since: number): NetEvent[];
  /**
   * Type this wallet's password into `field` and press `submit`, behind a
   * redaction card. The password never leaves this fixture.
   */
  enterPassword(field: Locator, submit: Locator, label: FootageLabel): Promise<void>;
  /** If an operation-password dialog appears within `windowMs`, confirm it. */
  confirmOperationPasswordIfAsked(windowMs?: number): Promise<boolean>;
  /**
   * Enter a secret value (a claim link) into `field`, press `submit`, confirm
   * the operation password if asked, and wait for `done`, all behind one
   * redaction card. The card lifts only once the value is off screen.
   */
  enterSecretText(field: Locator, value: string, submit: Locator, done: Locator, label: FootageLabel): Promise<void>;
  /** Digest a secret value into this wallet's footage canary (the caller drops its copy). */
  guardSecret(value: string): void;
}

async function importWallet(page: Page, extensionId: string, words: string[], password: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByTestId('onboarding-import-btn').click();
  await page.getByTestId('onboarding-import-warning-continue').click();
  for (let i = 0; i < words.length; i++) await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i] ?? '');
  await page.getByTestId('onboarding-import-continue').click();
  // The wizard fails closed until the backend's sign-up requirements resolve,
  // and its retry rebuilds the step with empty fields; re-enter before each
  // press. Retry only that race: other refusals count against the backend's
  // per-wallet restore budget.
  const submit = page.getByTestId('onboarding-set-password-submit');
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByTestId('onboarding-password-input').fill(password);
    await page.getByTestId('onboarding-password-confirm-input').fill(password);
    await submit.click();
    await page.waitForTimeout(3_000);
    if (!(await submit.isVisible().catch(() => false))) break;
    if (!/sign-up requirements/.test(await page.locator('#root').innerText())) break;
    await page.waitForTimeout(5_000);
  }
  await page.getByTestId('onboarding-setup-finish-btn').click({ timeout: 30_000 }).catch(() => {});
  const total = page.getByTestId('home-total-balance');
  await total.waitFor({ timeout: IMPORT_PATIENCE_MS }).catch(() => {
    throw new Error('the import never reached Home (screen withheld: it may show phrase or password entry)');
  });
  await expect
    .poll(async () => (await total.textContent())?.trim() ?? '', {
      timeout: IMPORT_PATIENCE_MS,
      message: 'the wallet never loaded a real balance set, so sign-in to the backend did not complete',
    })
    .toMatch(/\d/);
}

/** Opens each demo wallet once per worker, on first use. */
export class LiveWallets {
  private readonly open = new Map<WalletName, Promise<LiveWallet>>();
  private readonly contexts: BrowserContext[] = [];
  private readonly footages: WalletFootage[] = [];
  private readonly profiles: string;
  private readonly custody: string;
  private readonly extension: string;
  private testTitle = '';

  constructor() {
    assertPhrasesNotInEnvironment();
    const file = process.env.E2E_WALLET_FILE;
    if (!file) throw new Error('E2E_WALLET_FILE must name the owner-only demo wallet custody file.');
    this.custody = resolve(file);
    this.extension = extensionDir();
    // mkdtemp creates the directory 0700.
    this.profiles = mkdtempSync(join(tmpdir(), 'smirk-f-legacy-'));
  }

  beginTest(title: string): void {
    this.testTitle = title;
    for (const f of this.footages) f.beginTest(title);
  }

  get(name: WalletName): Promise<LiveWallet> {
    let wallet = this.open.get(name);
    if (!wallet) {
      wallet = this.launch(name);
      this.open.set(name, wallet);
      // A failed launch must not poison later tests in this worker.
      wallet.catch(() => this.open.delete(name));
    }
    return wallet;
  }

  private async launch(name: WalletName): Promise<LiveWallet> {
    const words = readWalletPhrase(this.custody, WALLET_VARS[name]);
    const password = randomBytes(24).toString('base64url');
    const canary = createCanary();
    canary.addPhrase(words);
    canary.addToken(password);

    // A fresh directory per launch: a failed import must not leave a locked profile behind.
    const context = await chromium.launchPersistentContext(mkdtempSync(join(this.profiles, `${name}-`)), {
      headless: !process.env.HEADED,
      channel: 'chromium',
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      env: browserEnvironment(),
      args: [`--disable-extensions-except=${this.extension}`, `--load-extension=${this.extension}`],
    });
    this.contexts.push(context);
    const events: NetEvent[] = [];
    context.on('response', (response) => {
      try {
        const u = new URL(response.url());
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
        events.push({ method: response.request().method(), host: u.host, path: u.pathname, status: response.status(), at: Date.now() });
        if (events.length > 20_000) events.splice(0, 5_000);
      } catch {
        // Unparseable URL: nothing to record.
      }
    });

    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(worker.url()).host;

    const footage = new WalletFootage(name, canary);
    footage.beginTest(this.testTitle);
    this.footages.push(footage);
    const page = context.pages()[0] ?? (await context.newPage());
    footage.attach(page);
    // Approval windows and any tab the wallet opens are recorded and guarded too.
    context.on('page', (p) => footage.attach(p));

    try {
      await footage.secret('Wallet import and unlock (redacted)', () => importWallet(page, extensionId, words, password));
    } finally {
      words.fill('');
    }
    await footage.settled(page, 'Home after import');

    const confirmPassword = async (windowMs: number): Promise<boolean> => {
      const field = page.getByTestId('operation-password');
      const asked = await field.waitFor({ state: 'visible', timeout: windowMs }).then(() => true, () => false);
      if (!asked) return false;
      await field.fill(password);
      await page.getByTestId('operation-password-confirm').click();
      await field.waitFor({ state: 'hidden', timeout: 60_000 });
      return true;
    };

    return {
      name,
      context,
      page,
      extensionId,
      footage,
      responses: (since) => events.filter((e) => e.at >= since),
      enterPassword: async (field, submit, label) => {
        await footage.secret(label, async () => {
          await field.fill(password);
          await submit.click();
          await field.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
        });
      },
      confirmOperationPasswordIfAsked: async (windowMs = 15_000) => {
        const asked = await page
          .getByTestId('operation-password')
          .waitFor({ state: 'visible', timeout: windowMs })
          .then(() => true, () => false);
        if (!asked) return false;
        // The empty field is masked while it waits; typing happens behind the card.
        return footage.secret('Password confirmation (redacted)', () => confirmPassword(1_000));
      },
      enterSecretText: async (field, value, submit, done, label) => {
        canary.addToken(value);
        await footage.secret(label, async () => {
          await field.fill(value);
          await submit.click();
          await confirmPassword(15_000);
          await done.first().waitFor({ state: 'visible', timeout: 30 * 60_000 });
        });
      },
      guardSecret: (value) => canary.addToken(value),
    };
  }

  async close(): Promise<void> {
    await Promise.all(this.footages.map((f) => f.close().catch(() => {})));
    await Promise.all(this.contexts.map((c) => c.close().catch(() => {})));
    rmSync(this.profiles, { recursive: true, force: true });
  }
}

export const test = base.extend<{ legacyFootageTitle: void }, { liveWallets: LiveWallets }>({
  liveWallets: [
    async ({}, use) => {
      const wallets = new LiveWallets();
      try {
        await use(wallets);
      } finally {
        await wallets.close();
      }
    },
    { scope: 'worker', timeout: 45 * 60_000 },
  ],
  // Footage markers carry the test title (a static string in the spec).
  legacyFootageTitle: [
    async ({ liveWallets }, use, testInfo) => {
      liveWallets.beginTest(testInfo.title);
      await use();
    },
    { auto: true },
  ],
});

export { expect };

// ── Extension state, read in the wallet page ────────────────────────────────
// Each helper filters inside the page and returns public data only.

export type LegacyState = 'funds' | 'empty' | 'not-scanned' | 'scanning' | 'error';
export interface LegacyFindingRecord {
  asset: 'btc' | 'ltc' | 'xmr' | 'wow';
  source: 'm44' | 'v1' | 'v2';
  address: string;
  state: LegacyState;
  spendableAtomic: string;
  pendingAtomic: string;
}
export interface LegacyCheckRecord {
  checkedAt: number;
  mode: 'probe' | 'scan';
  findings: LegacyFindingRecord[];
}

type StorageArea = {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  getKeys?: () => Promise<string[]>;
  remove(keys: string | string[]): Promise<void>;
};

/** The older-address check record of the one wallet in this profile, or null. */
export async function readLegacyRecord(page: Page): Promise<LegacyCheckRecord | null> {
  const records = await page.evaluate(async () => {
    const local = (globalThis as unknown as { chrome: { storage: { local: StorageArea } } }).chrome.storage.local;
    const keys = local.getKeys ? await local.getKeys() : Object.keys(await local.get(null));
    const wanted = keys.filter((k) => k.startsWith('smirk:legacy-funds:v1:'));
    if (wanted.length === 0) return [];
    const got = await local.get(wanted);
    return wanted.map((k) => got[k]);
  });
  if (records.length > 1) throw new Error('more than one wallet record in a single-wallet profile');
  return (records[0] as LegacyCheckRecord | undefined) ?? null;
}

/** Forget the stored check (display state only), so the next unlock may check again. */
export async function forgetLegacyRecord(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const local = (globalThis as unknown as { chrome: { storage: { local: StorageArea } } }).chrome.storage.local;
    const keys = local.getKeys ? await local.getKeys() : Object.keys(await local.get(null));
    const wanted = keys.filter((k) => k.startsWith('smirk:legacy-funds:v1:'));
    if (wanted.length) await local.remove(wanted);
  });
}

/** Shape of the encrypted send journal: whether it is sealed, its size and a digest. Never its content. */
export async function sendJournalState(page: Page): Promise<{ sealed: boolean; length: number; digest: string } | null> {
  return page.evaluate(async () => {
    const local = (globalThis as unknown as { chrome: { storage: { local: StorageArea } } }).chrome.storage.local;
    const keys = local.getKeys ? await local.getKeys() : Object.keys(await local.get(null));
    const slot = keys.find((k) => k.startsWith('smirk_send_journal_v1:'));
    if (!slot) return null;
    const raw = (await local.get(slot))[slot] as { v?: unknown; ct?: unknown; entries?: unknown } | undefined;
    const sealed = !!raw && raw.v === 2 && typeof raw.ct === 'string' && !('entries' in raw);
    const text = sealed ? String(raw!.ct) : '';
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return { sealed, length: text.length, digest };
  });
}

// ── Navigation and reads, every tap through the footage ─────────────────────

/** A tab tap restores that tab's last screen; a second tap returns to its root. */
export async function tabRoot(w: LiveWallet, tab: 'home' | 'settings' | 'inbox', label: FootageLabel): Promise<void> {
  const nav = w.page.getByTestId(`nav-tab-${tab}`);
  await w.footage.tap(nav, label);
  await w.footage.tap(nav, label);
}

export async function openOlderAddresses(w: LiveWallet): Promise<void> {
  await tabRoot(w, 'settings', 'Open Settings');
  await w.footage.tap(w.page.getByTestId('settings-old-addresses-nav'), 'Settings: Older addresses and tips');
  await expect(w.page.getByTestId('legacy-funds-route')).toBeVisible();
  await w.footage.settled(w.page, 'Settings: Older addresses and tips');
}

/** First decimal number in a rendered amount ("0.0049 LTC", "1,234.5"). */
export function parseAmount(text: string | null | undefined): number | null {
  const m = (text ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m?.[1] ? Number(m[1]) : null;
}

/** The asset's full-precision balance from its detail screen, then back to Home. */
export async function assetBalance(w: LiveWallet, asset: 'btc' | 'ltc' | 'xmr' | 'wow', hold: 'settled' | 'result'): Promise<number> {
  await tabRoot(w, 'home', 'Back to Home');
  await w.footage.tap(w.page.getByTestId(`asset-row-${asset}`), 'Open asset');
  const balance = w.page.getByTestId('asset-detail-balance');
  await expect.poll(async () => parseAmount(await balance.textContent()), { timeout: 120_000 }).not.toBeNull();
  if (hold === 'result') await w.footage.result('Asset balance');
  else await w.footage.settled(w.page, 'Asset balance');
  const value = parseAmount(await balance.textContent());
  await w.footage.tap(w.page.getByTestId('asset-detail-back'), 'Back to Home');
  return value ?? 0;
}

/**
 * Retry `check` every `intervalMs` until it returns true; throw `message` once
 * `timeoutMs` has passed. For confirmations and settlement, which take blocks.
 */
export async function until(
  check: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs: number; message: string },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(opts.message);
    await new Promise((r) => setTimeout(r, Math.min(opts.intervalMs, Math.max(0, deadline - Date.now()))));
  }
}

/**
 * Watch for something that must NOT happen for a whole window. Returns true if
 * it stayed absent. A wait is the assertion here, so it lives in the fixture.
 */
export async function staysAbsent(probe: () => Promise<boolean>, windowMs: number, intervalMs = 5_000): Promise<boolean> {
  const until = Date.now() + windowMs;
  while (Date.now() < until) {
    if (await probe()) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return !(await probe());
}

/** Resolve with the txid of the next UTXO broadcast this page makes (the txid only). */
export function nextUtxoBroadcastTxid(page: Page, timeoutMs: number): Promise<string> {
  const pending = page
    .waitForResponse(
      (r) => r.request().method() === 'POST' && /\/wallet\/(utxo\/)?broadcast$/.test(new URL(r.url()).pathname),
      { timeout: timeoutMs },
    )
    .then(async (r) => {
      const body = (await r.json().catch(() => null)) as { txid?: unknown; data?: { txid?: unknown } } | null;
      const txid = body?.txid ?? body?.data?.txid;
      return typeof txid === 'string' ? txid : '';
    });
  // Awaited later, or never if the test fails first; either way not an unhandled rejection.
  pending.catch(() => {});
  return pending;
}

/** Read a single owner-only fixture line (a claim link) the same way as a phrase file, without word rules. */
export function readOwnerOnlyValue(file: string, variable: string): string {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('fixture file must be a regular owner-only (0600) file owned by this user');
  }
  const matches = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.match(new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=\\s*(.*)$`)))
    .filter((m): m is RegExpMatchArray => m !== null);
  if (matches.length !== 1) throw new Error(`expected exactly one ${variable} assignment in the fixture file`);
  return (matches[0]?.[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}
