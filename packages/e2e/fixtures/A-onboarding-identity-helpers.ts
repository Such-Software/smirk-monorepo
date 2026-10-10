/**
 * Helpers for area A (onboarding, lock policy, website sign-in, settings and
 * identity), shared by its live specs and the fundless specs it extends.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import type { GuardedFootage } from './guarded-footage.js';
import type { LiveProfile } from './live-wallets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * When the unlocked-session cache expires, or undefined when there is none.
 * Only the expiry crosses out of the page; the cached keys stay there.
 */
export async function sessionExpiry(page: Page): Promise<number | undefined> {
  return page.evaluate(async () => {
    const chromeApi = (globalThis as unknown as { chrome: { storage: { session: { get(k: string): Promise<Record<string, unknown>> } } } }).chrome;
    const entry = (await chromeApi.storage.session.get('smirk_unlocked_session_cache')).smirk_unlocked_session_cache as
      | { expiresAtMs?: unknown }
      | undefined;
    return typeof entry?.expiresAtMs === 'number' ? entry.expiresAtMs : undefined;
  });
}

/**
 * A fresh install opens setup in a tab by itself (background `onInstalled`),
 * asynchronously. Wait for it, bounded, so it is never mistaken for a page a
 * test's own click opened. Returns the tab, or null if none appeared.
 */
export async function settleInstallTab(context: BrowserContext, patience = 10_000): Promise<Page | null> {
  const deadline = Date.now() + patience;
  while (Date.now() < deadline) {
    const tab = context.pages().find((page) => /popup\.html\?ctx=tab/.test(page.url()));
    if (tab) return tab;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/** Lines on screen while registration mines its proof of work. */
const POW_SCREEN = /much PoW|such proof|very work|so hash|many bits|wow so secure|proof-of-work/;

/** Resolves true if the proof-of-work screen shows up within `patience`. */
export function watchForProofOfWork(page: Page, patience = 120_000): Promise<boolean> {
  return page.getByText(POW_SCREEN).first().waitFor({ state: 'visible', timeout: patience }).then(() => true, () => false);
}

/** Open the action popup, press Create, and follow the hand-off to the tab. */
export async function openCreateTab(footage: GuardedFootage, profile: LiveProfile): Promise<Page> {
  const popup = profile.page;
  await popup.goto(profile.popupUrl());
  await expect(popup.getByTestId('onboarding-create-btn')).toBeVisible({ timeout: 30_000 });
  await footage.settled(popup, 'welcome screen');
  const existing = new Set(profile.context.pages());
  const opened = profile.context.waitForEvent('page', { timeout: 30_000, predicate: (page) => !existing.has(page) });
  await footage.tap(popup.getByTestId('onboarding-create-btn'), 'create a new wallet');
  const tab = await opened;
  await tab.waitForLoadState('domcontentloaded');
  expect(tab.url(), 'create must hand off to the tab-hosted surface').toContain('ctx=tab');
  await expect.poll(() => popup.isClosed(), { message: 'the popup should close once it has handed off' }).toBe(true);
  profile.page = tab;
  await expect(tab.getByTestId('onboarding-create-btn')).toBeVisible({ timeout: 30_000 });
  return tab;
}

/** Optional non-secret baseline: expected user ids and npubs per demo wallet. */
export interface WalletBaseline { userId?: string; npub?: string }

/** E2E_BASELINE_FILE, when set: `{ "alice": { "userId": "...", "npub": "npub1..." }, ... }`. */
export function loadBaseline(): Record<string, WalletBaseline> | null {
  const file = process.env.E2E_BASELINE_FILE;
  if (!file) return null;
  if (!existsSync(file)) throw new Error('E2E_BASELINE_FILE does not exist');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('E2E_BASELINE_FILE must hold a JSON object keyed by wallet name');
  return parsed as Record<string, WalletBaseline>;
}

/**
 * A Smirk website challenge naming https://smirk.cash, fetched from the backend
 * exactly as the website asks for one. Falls back to the documented format if
 * the backend refuses (the wallet's check is on the text alone); `live` says
 * which was used. A challenge is a public nonce, not a credential.
 */
export async function websiteChallenge(backend: string, origin = 'https://smirk.cash'): Promise<{ text: string; live: boolean }> {
  try {
    const res = await fetch(`${backend.replace(/\/$/, '')}/auth/website/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { challenge?: unknown };
      if (typeof body.challenge === 'string' && /^\s*smirk authentication challenge\s*\n/i.test(body.challenge)) {
        return { text: body.challenge, live: true };
      }
    }
  } catch {
    /* fall through to the documented format */
  }
  return {
    text: `Smirk Authentication Challenge\nNonce: e2e-${Date.now().toString(36)}\nOrigin: ${origin}\nTimestamp: ${new Date().toISOString()}`,
    live: false,
  };
}

const DUMMY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dummy origin</title>
<style>
  body { font: 15px/1.45 system-ui, sans-serif; background: #111118; color: #e8e8f0; margin: 0; padding: 18px; }
  h1 { font-size: 18px; margin: 0 0 6px; } p { opacity: .75; margin: 0 0 14px; }
  button { display: block; width: 100%; margin: 0 0 8px; padding: 10px; font: inherit; border-radius: 8px;
    border: 1px solid #444; background: #22222c; color: inherit; text-align: left; }
  li { margin: 6px 0; padding: 8px; border-radius: 6px; background: #1b1b24; word-break: break-word; }
  li[data-outcome="refused"] { border-left: 4px solid #22c55e; } li[data-outcome="rejected"] { border-left: 4px solid #f5c542; }
  li[data-outcome="signed"], li[data-outcome="error"] { border-left: 4px solid #ef4444; }
</style></head>
<body>
<h1>A site that is not smirk.cash</h1>
<p>Each button asks the Smirk wallet for something it must refuse, except the last, which it must ask the user about.</p>
<button data-testid="try-foreign-signin">Sign a smirk.cash sign-in challenge</button>
<button data-testid="try-empty-sign">Sign an empty message</button>
<button data-testid="try-number-sign">Sign a number</button>
<button data-testid="try-array-sign">Sign an array holding a reserved message</button>
<button data-testid="try-object-sign">Sign an object</button>
<button data-testid="try-empty-signin">Sign in with an empty message</button>
<button data-testid="try-plain-signin">Sign in with an ordinary message</button>
<ol id="results"></ol>
<script>
  const results = document.getElementById('results');
  function show(id, outcome, detail) {
    let item = document.querySelector('[data-testid="result-' + id + '"]');
    if (!item) { item = document.createElement('li'); item.dataset.testid = 'result-' + id; results.appendChild(item); }
    item.dataset.outcome = outcome;
    item.textContent = id + ': ' + outcome + (detail ? ' (' + detail + ')' : '');
  }
  async function attempt(id, run) {
    show(id, 'pending');
    try { await run(); show(id, 'signed'); }
    catch (error) {
      const code = error && error.code;
      const outcome = code === 'USER_REJECTED' ? 'rejected' : code === 'INVALID_PARAMS' ? 'refused' : 'error';
      show(id, outcome, String((error && error.message) || error).slice(0, 200));
    }
  }
  const smirk = () => window.smirk;
  const on = (id, run) => document.querySelector('[data-testid="try-' + id + '"]').addEventListener('click', () => attempt(id, run));
  on('foreign-signin', () => smirk().signIn(window.smirkChallenge, ['btc']));
  on('empty-sign', () => smirk().signMessage(''));
  on('number-sign', () => smirk().signMessage(42));
  on('array-sign', () => smirk().signMessage(['smirk-auth-1']));
  on('object-sign', () => smirk().signMessage({ message: 'hello' }));
  on('empty-signin', () => smirk().signIn('', ['btc']));
  on('plain-signin', () => smirk().signIn('Sign in to the e2e dummy page', ['btc']));
</script>
</body></html>`;

/** A local http origin (127.0.0.1, a random port) serving the dummy page. */
export async function startDummySite(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(DUMMY_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the dummy site did not bind a port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Fundless-suite helpers (the default config, no footage) ────────────────

const EXTENSION_DIST = process.env.EXTENSION_DIST ?? join(__dirname, '..', '..', 'extension', 'dist');

/**
 * A second persistent profile with the extension, for specs that need two
 * independent installs (re-import into a clean profile). Mirrors the context
 * fixture in fixtures/extension.ts; the caller closes it.
 */
export async function launchExtensionContext(): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await chromium.launchPersistentContext('', {
    headless: !process.env.HEADED,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_DIST}`, `--load-extension=${EXTENSION_DIST}`, '--no-sandbox'],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  return { context, extensionId: new URL(worker.url()).host };
}

/**
 * Create, verify and register a brand-new wallet in a tab, without capture.
 * The generated words stay in this function and are zeroed before it returns.
 */
export async function createFreshWallet(page: Page, extensionId: string, password: string): Promise<void> {
  const words: string[] = [];
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html?ctx=tab`);
    await page.getByTestId('onboarding-create-btn').click();
    await expect(page.getByTestId('onboarding-create-seed-word-0')).toBeVisible({ timeout: 15_000 });
    const count = await page.locator('[data-testid^="onboarding-create-seed-word-"]').count();
    for (let i = 0; i < count; i++) {
      words.push(((await page.getByTestId(`onboarding-create-seed-word-${i}`).textContent()) ?? '').trim().toLowerCase());
    }
    if (![12, 24].includes(words.length) || words.some((word) => !word)) throw new Error('the generated phrase is incomplete');
    await page.locator('input[type="checkbox"]').first().check();
    await page.getByTestId('onboarding-create-backed-up-continue').click();
    await expect(page.getByTestId('onboarding-create-continue')).toBeVisible({ timeout: 15_000 });
    for (let i = 0; i < words.length; i++) {
      const input = page.getByTestId(`onboarding-verify-word-${i}`);
      if (await input.count()) await input.fill(words[i]!);
    }
    await page.getByTestId('onboarding-create-continue').click();
  } finally {
    words.fill('');
  }
  await page.getByTestId('onboarding-password-input').fill(password);
  await page.getByTestId('onboarding-password-confirm-input').fill(password);
  await page.getByTestId('onboarding-set-password-submit').click();
  await page.getByTestId('onboarding-setup-finish-btn').click({ timeout: 5 * 60_000 }).catch(() => {});
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 5 * 60_000 });
}
