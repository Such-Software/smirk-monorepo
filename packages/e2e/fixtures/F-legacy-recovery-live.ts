/**
 * Live wallets for the F-legacy-recovery lane (older addresses, the move flow
 * and old-server tips) against a real backend. Gates, preflight, evidence and
 * the wallet lock live in `F-legacy-recovery-lane.mjs`.
 *
 * WALLET CUSTODY. The demo wallets' phrases are read in-process, one named line
 * at a time, from the owner-only custody file named by `E2E_WALLET_FILE` (the
 * same rules as `demo/capture-demo.mjs` readWalletPhrase: a regular 0600 file
 * owned by this user, exactly one assignment, 12 or 24 lowercase words). The
 * file is never sourced into the environment: that would hand the phrases to
 * every child process, browsers included, so this lane refuses to start when
 * any SMOKE_*_MNEMONIC variable is set, and launches each browser with an
 * environment stripped of secret-looking names.
 *
 * Each wallet gets its own persistent Chromium profile under a 0700 scratch
 * directory, a random password that lives only in this process, its own
 * footage session and a lock (no other live run may open it meanwhile). The
 * words are digested into the footage canary and then blanked. Profiles are
 * deleted when the worker ends.
 *
 * WAITS. Every element wait and action is bounded (`ACTION_TIMEOUT_MS` unless a
 * longer, named patience applies), so a missing screen fails with its cause
 * instead of recording one screen until the test timeout. Nothing sleeps.
 *
 * NETWORK EVIDENCE. Each context records method, host, path and status of the
 * wallet page's own requests (never query strings or bodies: LWS requests carry
 * view keys). Two helpers read one field of one response: a UTXO broadcast's
 * txid, and whether an old-server sign-in created a new account (`is_new`).
 */

import { chromium, expect, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base } from './private-test.js';
import { createCanary, type Canary } from './F-legacy-recovery-guard.mjs';
import { WalletFootage, type FootageLabel } from './F-legacy-recovery-footage.js';
import {
  ACTION_TIMEOUT_MS,
  LaneEvidence,
  WALLET_NAMES,
  acquireWalletLock,
  assertOwnerOnlyFile,
  laneGates,
  lanePreflight,
  type ReleaseFacts,
  type WalletName,
} from './F-legacy-recovery-lane.mjs';
import { watchContext } from './failure-context.js';

export { WALLET_NAMES, type WalletName };

const WALLET_VARS: Record<WalletName, string> = {
  alice: 'SMOKE_ALICE_MNEMONIC',
  bob: 'SMOKE_BOB_MNEMONIC',
  carol: 'SMOKE_CAROL_MNEMONIC',
};

const GATES = laneGates();
/** The spec declares its tests only inside this lane's own invocation, with E2E_LIVE=1. */
export const LIVE = GATES.declared;

const VIEWPORT = { width: 380, height: 600 };
/** Import, registration and the first full balance refresh. */
const IMPORT_PATIENCE_MS = 10 * 60_000;
/** One step of the import wizard. */
const IMPORT_STEP_MS = 2 * 60_000;
/** A balance refresh, through slow chains. */
const BALANCE_PATIENCE_MS = 5 * 60_000;

/** Read exactly one NAME=value phrase line from an owner-only file; never print it. */
export function readWalletPhrase(file: string, variable: string): string[] {
  assertOwnerOnlyFile(file, 'the wallet custody file');
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
  /** When this wallet's browser started, and when its import finished with a loaded balance set (ms epoch). */
  readonly launchedAt: number;
  readonly importedAt: number;
  /** Responses seen by this wallet's pages since `since` (ms epoch). */
  responses(since: number): NetEvent[];
  /**
   * Type this wallet's password into `field` and press `submit`, behind a
   * redaction card. The password never leaves this fixture.
   */
  enterPassword(field: Locator, submit: Locator, label: FootageLabel): Promise<void>;
  /**
   * If an operation-password dialog appears within `windowMs`, confirm it.
   * `intoCountdown`: what the confirmation leads to counts itself down (the
   * Send receipt), so the screen after it is not held (see the footage).
   */
  confirmOperationPasswordIfAsked(windowMs?: number, options?: { intoCountdown?: boolean }): Promise<boolean>;
  /**
   * Enter a secret value (a claim link) into `field`, press `submit`, confirm
   * the operation password if asked, and wait for `done`, all behind one
   * redaction card. The card lifts only once the value is off screen.
   */
  enterSecretText(field: Locator, value: string, submit: Locator, done: Locator, label: FootageLabel): Promise<void>;
  /** Digest a secret value into this wallet's footage canary (the caller drops its copy). */
  guardSecret(value: string): void;
  /** Open the wallet in a new window of the same profile (recorded and guarded like the first). */
  openWindow(): Promise<Page>;
}

/** Resolve with the label of the first promise to settle successfully, or 'timeout'. */
async function firstOf<K extends string>(waits: Record<K, Promise<unknown>>, timeoutMs: number): Promise<K | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), timeoutMs);
  });
  const labelled = (Object.entries(waits) as [K, Promise<unknown>][]).map(([label, p]) =>
    p.then(
      () => label,
      () => new Promise<never>(() => {}),
    ),
  );
  try {
    return await Promise.race([...labelled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Balances as last refreshed: whether a refresh landed, and which assets came back with an error. Public data only. */
export async function balanceSnapshotState(page: Page): Promise<{ cachedAt: number; failed: string[]; assets: number } | null> {
  return page.evaluate(async () => {
    const area = (globalThis as unknown as { chrome: { storage: { session: { get(k: string): Promise<Record<string, unknown>> } } } }).chrome
      .storage.session;
    const raw = (await area.get('smirk_balance_snapshot_v2'))['smirk_balance_snapshot_v2'] as
      | { cachedAt?: number; balances?: Record<string, { error?: string }> }
      | undefined;
    if (!raw || typeof raw.cachedAt !== 'number' || !raw.balances) return null;
    const assets = Object.keys(raw.balances);
    return { cachedAt: raw.cachedAt, failed: assets.filter((k) => !!raw.balances?.[k]?.error), assets: assets.length };
  });
}

/** The Home freshness cue's level ('fresh' means a refresh landed and none is in flight), or null off Home. */
async function freshness(page: Page): Promise<string | null> {
  const cue = page.getByTestId('balance-freshness-cue');
  if ((await cue.count()) === 0) return null;
  return cue.first().getAttribute('data-freshness');
}

/**
 * Wait until Home shows balances that came from a completed refresh: the
 * snapshot exists, `asset` (or at least one asset) loaded without an error, and
 * no refresh is in flight. A rendered "0" or "$0.00" before that is a
 * placeholder, not a balance.
 */
export async function waitForLoadedBalances(page: Page, asset: string | null, patienceMs = BALANCE_PATIENCE_MS): Promise<void> {
  await expect
    .poll(
      async () => {
        const snap = await balanceSnapshotState(page).catch(() => null);
        if (!snap) return 'no refresh has completed';
        if (asset ? snap.failed.includes(asset) : snap.failed.length >= snap.assets) return 'the balance read failed';
        const level = await freshness(page);
        return level === 'fresh' ? 'loaded' : `refresh ${level ?? 'state unknown'}`;
      },
      { timeout: patienceMs, intervals: [1_000, 2_000, 5_000], message: `the ${asset ?? 'wallet'} balance never loaded from a completed refresh` },
    )
    .toBe('loaded');
}

async function importWallet(page: Page, extensionId: string, words: string[], password: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { timeout: ACTION_TIMEOUT_MS });
  await page.getByTestId('onboarding-import-btn').click();
  await page.getByTestId('onboarding-import-warning-continue').click();
  for (let i = 0; i < words.length; i++) await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i] ?? '');
  await page.getByTestId('onboarding-import-continue').click();
  // The wizard fails closed until the backend's sign-up requirements resolve:
  // the press is refused (the password step stays, with a message), the wizard
  // re-reads the capabilities, and the next press proceeds. Retry only that
  // case, once the re-read has landed; other refusals count against the
  // backend's per-wallet restore budget. Its retry rebuilds the step with empty
  // fields, so re-enter before each press.
  const submit = page.getByTestId('onboarding-set-password-submit');
  for (let attempt = 1; ; attempt++) {
    let pressedAt = Number.POSITIVE_INFINITY;
    const reread = page.waitForResponse((r) => Date.now() >= pressedAt && new URL(r.url()).pathname.endsWith('/capabilities'), {
      timeout: IMPORT_STEP_MS,
    });
    reread.catch(() => {});
    await page.getByTestId('onboarding-password-input').fill(password);
    await page.getByTestId('onboarding-password-confirm-input').fill(password);
    pressedAt = Date.now();
    await submit.click();
    const left = submit.waitFor({ state: 'hidden', timeout: IMPORT_STEP_MS });
    const outcome = await firstOf({ left, reread }, IMPORT_STEP_MS);
    if (outcome === 'timeout') throw new Error('the import stayed on the password step: the wallet refused it (screen withheld)');
    // A re-read can also accompany a press that proceeds; the step leaving decides.
    if (outcome === 'left' || (await firstOf({ left }, 5_000)) === 'left') break;
    if (attempt >= 4) throw new Error("the backend's sign-up requirements never resolved after 4 attempts");
  }
  const finish = page.getByTestId('onboarding-setup-finish-btn');
  const total = page.getByTestId('home-total-balance');
  const reached = await firstOf(
    { finish: finish.waitFor({ state: 'visible', timeout: IMPORT_PATIENCE_MS }), home: total.waitFor({ state: 'visible', timeout: IMPORT_PATIENCE_MS }) },
    IMPORT_PATIENCE_MS,
  );
  if (reached === 'timeout') throw new Error('the import never reached the setup step or Home (screen withheld: it may show phrase or password entry)');
  if (reached === 'finish') await finish.click();
  await total.waitFor({ state: 'visible', timeout: IMPORT_PATIENCE_MS }).catch(() => {
    throw new Error('the import never reached Home after setup (screen withheld)');
  });
  await waitForLoadedBalances(page, null, IMPORT_PATIENCE_MS);
}

/** Opens each demo wallet once per worker, on first use. */
export class LiveWallets {
  private readonly open = new Map<WalletName, Promise<LiveWallet>>();
  private readonly contexts: BrowserContext[] = [];
  private readonly footages: WalletFootage[] = [];
  private readonly canaries: Canary[] = [];
  private readonly releases: (() => void)[] = [];
  private readonly profiles: string;
  private readonly custody: string;
  private readonly extension: string;
  readonly release: ReleaseFacts;
  readonly evidence: LaneEvidence;
  private testTitle = '';

  constructor() {
    // Cheap refusals first: the lane config ran these too, and a worker re-checks.
    this.release = lanePreflight();
    this.custody = resolve(process.env.E2E_WALLET_FILE!);
    this.extension = resolve(process.env.EXTENSION_DIST!);
    this.evidence = new LaneEvidence((value) => this.canaries.some((c) => c.hit([value])));
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
    this.releases.push(await acquireWalletLock(name));
    const words = readWalletPhrase(this.custody, WALLET_VARS[name]);
    const password = randomBytes(24).toString('base64url');
    const canary = createCanary();
    canary.addPhrase(words);
    canary.addToken(password);
    this.canaries.push(canary);
    const launchedAt = Date.now();

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
    // Request shapes and screen test ids for the private failure log; no values.
    watchContext(name, context);
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
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
    const importedAt = Date.now();
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
      launchedAt,
      importedAt,
      responses: (since) => events.filter((e) => e.at >= since),
      enterPassword: async (field, submit, label) => {
        await footage.secret(label, async () => {
          await field.fill(password);
          await submit.click();
          await field.waitFor({ state: 'hidden', timeout: 60_000 });
        });
      },
      confirmOperationPasswordIfAsked: async (windowMs = 15_000, options = {}) => {
        const asked = await page
          .getByTestId('operation-password')
          .waitFor({ state: 'visible', timeout: windowMs })
          .then(() => true, () => false);
        if (!asked) return false;
        // The empty field is masked while it waits; typing happens behind the card.
        return footage.secret('Password confirmation (redacted)', () => confirmPassword(1_000), options);
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
      openWindow: async () => {
        const next = await context.newPage();
        await next.goto(`chrome-extension://${extensionId}/popup.html`, { timeout: ACTION_TIMEOUT_MS });
        return next;
      },
    };
  }

  async close(): Promise<void> {
    await Promise.all(this.footages.map((f) => f.close().catch(() => {})));
    await Promise.all(this.contexts.map((c) => c.close().catch(() => {})));
    rmSync(this.profiles, { recursive: true, force: true });
    for (const release of this.releases) release();
  }
}

export const test = base.extend<{ legacyLaneTest: void }, { liveWallets: LiveWallets }>({
  liveWallets: [
    async ({}, use) => {
      const wallets = new LiveWallets();
      wallets.evidence.note('(worker)', 'release-zip-sha256', wallets.release.zipSha256);
      if (wallets.release.sourceCommit) wallets.evidence.note('(worker)', 'release-source-commit', wallets.release.sourceCommit);
      try {
        await use(wallets);
      } finally {
        await wallets.close();
      }
    },
    { scope: 'worker', timeout: 45 * 60_000 },
  ],
  // Footage markers carry the test title (a static string in the spec); the
  // evidence file keeps each test's status and any skip reason, which the
  // private reporter does not print.
  legacyLaneTest: [
    async ({ liveWallets }, use, testInfo) => {
      liveWallets.beginTest(testInfo.title);
      try {
        await use();
      } finally {
        const skip = testInfo.annotations.find((a) => a.type === 'skip');
        if (testInfo.status === 'skipped' && skip?.description) liveWallets.evidence.note(testInfo.title, 'skipped', skip.description);
        liveWallets.evidence.note(testInfo.title, 'status', testInfo.status ?? 'unknown');
      }
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
export async function tabRoot(w: LiveWallet, tab: 'home' | 'settings' | 'inbox', label: FootageLabel, page: Page = w.page): Promise<void> {
  const nav = page.getByTestId(`nav-tab-${tab}`);
  await w.footage.tap(nav, label);
  await w.footage.tap(nav, label);
}

export async function openOlderAddresses(w: LiveWallet, page: Page = w.page): Promise<void> {
  await tabRoot(w, 'settings', 'Open Settings', page);
  await w.footage.tap(page.getByTestId('settings-old-addresses-nav'), 'Settings: Older addresses and tips');
  await expect(page.getByTestId('legacy-funds-route')).toBeVisible();
}

/** First decimal number in a rendered amount ("0.0049 LTC", "1,234.5"). */
export function parseAmount(text: string | null | undefined): number | null {
  const m = (text ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * The asset's full-precision confirmed balance from its detail screen, read
 * only once Home has a completed refresh for that asset and two reads agree;
 * then back to Home.
 */
export async function assetBalance(w: LiveWallet, asset: 'btc' | 'ltc' | 'xmr' | 'wow', hold: 'settled' | 'result'): Promise<number> {
  await tabRoot(w, 'home', 'Back to Home');
  await waitForLoadedBalances(w.page, asset);
  await w.footage.tap(w.page.getByTestId(`asset-row-${asset}`), 'Open asset');
  const balance = w.page.getByTestId('asset-detail-balance');
  let previous: number | null = null;
  await expect
    .poll(
      async () => {
        const now = parseAmount(await balance.textContent());
        const stable = now !== null && now === previous;
        previous = now;
        return stable;
      },
      { timeout: ACTION_TIMEOUT_MS, intervals: [2_000], message: `the ${asset} balance on its detail screen never read the same twice` },
    )
    .toBe(true);
  if (hold === 'result') await w.footage.result('Asset balance');
  else await w.footage.settled(w.page, 'Asset balance');
  const value = parseAmount(await balance.textContent());
  await w.footage.tap(w.page.getByTestId('asset-detail-back'), 'Back to Home');
  if (value === null) throw new Error(`the ${asset} balance could not be read`);
  return value;
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

const isUtxoBroadcast = (r: Response) => r.request().method() === 'POST' && /\/wallet\/(utxo\/)?broadcast$/.test(new URL(r.url()).pathname);

/** Resolve with the txid of the next UTXO broadcast this page makes (the txid only). */
export function nextUtxoBroadcastTxid(page: Page, timeoutMs: number): Promise<string> {
  const pending = page.waitForResponse(isUtxoBroadcast, { timeout: timeoutMs }).then(async (r) => {
    const body = (await r.json().catch(() => null)) as { txid?: unknown; data?: { txid?: unknown } } | null;
    const txid = body?.txid ?? body?.data?.txid;
    return typeof txid === 'string' ? txid : '';
  });
  // Awaited later, or never if the test fails first; either way not an unhandled rejection.
  pending.catch(() => {});
  return pending;
}

/** Every broadcast path the wallet uses: UTXO, LWS (XMR/WOW) and Grin. */
export const BROADCAST_PATH = /\/wallet\/((utxo\/)?broadcast|lws\/submit(_tx)?|grin\/broadcast)$/;

/**
 * Resolve with whether the next old-server sign-in made a NEW account (true),
 * found an existing one (false), or failed (null). Reads `user.is_new` and
 * nothing else from the response; the access token in the same body is
 * never kept.
 */
export function nextLegacySignIn(page: Page, host: string, timeoutMs: number): Promise<boolean | null> {
  const pending = page
    .waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).host === host && new URL(r.url()).pathname.endsWith('/auth/extension'),
      { timeout: timeoutMs },
    )
    .then(async (r) => {
      if (!r.ok()) return null;
      const body = (await r.json().catch(() => null)) as { user?: { is_new?: unknown } } | null;
      return typeof body?.user?.is_new === 'boolean' ? body.user.is_new : null;
    });
  pending.catch(() => {});
  return pending;
}

/** Read a single owner-only fixture line (a claim link) the same way as a phrase file, without word rules. */
export function readOwnerOnlyValue(file: string, variable: string): string {
  assertOwnerOnlyFile(file, 'the fixture file');
  const matches = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.match(new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=\\s*(.*)$`)))
    .filter((m): m is RegExpMatchArray => m !== null);
  if (matches.length !== 1) throw new Error(`expected exactly one ${variable} assignment in the fixture file`);
  return (matches[0]?.[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}
