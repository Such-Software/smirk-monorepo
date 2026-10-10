/**
 * The live lane's three demo wallets, for the send, receive and history specs.
 *
 * One worker-scoped fixture imports alice, bob and carol once, each into its
 * own persistent Chromium profile of the release-candidate extension, and
 * hands the specs a page per wallet plus the lane's safety rails
 * (fixtures/live-send.ts) and footage hooks
 * (fixtures/B-send-receive-history-footage.ts).
 *
 * Custody. Phrases are read in process, one NAME=value line at a time, from
 * the owner-only file named by E2E_LIVE_WALLET_FILE (regular file, mode 0600,
 * owned by this user; the same rules as demo/capture-demo.mjs). Nothing is
 * `set -a` into the environment, so no child process or browser ever sees a
 * phrase. Each password is random and stays in memory. The word arrays are
 * zeroed once typed; only keyed 4-word hashes remain, for the footage canary.
 * Import and password entry happen before recording starts and appear in the
 * footage only as a labelled redaction card.
 *
 * Gates, each its own opt-in:
 *   E2E_LIVE=1              registers the live specs at all
 *   E2E_LIVE_MONEY=1        allows any broadcast
 *   ALLOW_PROD_WRITES=1     required when BACKEND_URL is a shared host
 *   FOOTAGE=guarded         records (see the footage module)
 *
 * Inputs:
 *   BACKEND_URL                 the API the build targets, with /api/v1
 *   E2E_LIVE_WALLET_FILE        owner-only phrase file (path only; never its content)
 *   E2E_LIVE_EXTENSION_ZIP      the staged store zip to test, verified against
 *   E2E_LIVE_EXTENSION_SHA256   ...this hash before unpacking; or else
 *   EXTENSION_DIST              an unpacked build
 *   E2E_LIVE_RUN_LABEL          e.g. run-11204; names the run directory
 *   E2E_LIVE_RUN_DIR            overrides ~/Build/smirk-e2e/v<version>-<label>
 *
 * The run directory (0700) holds the address book, the spend ledger, a
 * progress log of non-secret steps, and footage. Profiles are deleted at the
 * end of the worker.
 */

import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test as base } from './private-test.js';
import {
  AddressBook,
  BroadcastMonitor,
  SpendLedger,
  WALLET_NAMES,
  type WalletName,
} from './live-send.js';
import {
  SecretCanary,
  createFootage,
  footageEnabled,
  writeFootageManifest,
  type WalletFootage,
} from './B-send-receive-history-footage.js';

export const LIVE_LANE = process.env.E2E_LIVE === '1';
export const LANE = 'B-send-receive-history';

const WALLET_VARIABLE: Readonly<Record<WalletName, string>> = {
  alice: 'SMOKE_ALICE_MNEMONIC',
  bob: 'SMOKE_BOB_MNEMONIC',
  carol: 'SMOKE_CAROL_MNEMONIC',
};

/** Explorer hosts the history sheet can open. Served locally so no txid reaches a third party. */
export const EXPLORER_HOSTS = [
  'mempool.space',
  'litecoinspace.org',
  'xmrchain.net',
  'explore.wownero.com',
  'grincoin.org',
] as const;

const VIEWPORT = { width: 380, height: 600 };

/**
 * Read exactly one NAME=value line from an owner-only file and return its
 * words. Mirrors demo/capture-demo.mjs `readWalletPhrase`; refuses a symlink,
 * group or world access, another owner, or anything that is not a 12 or 24
 * lowercase-word phrase. Never prints the value.
 */
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
  const phrase = (matches[0]![1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const words = phrase.split(/\s+/);
  if (![12, 24].includes(words.length) || words.some((word) => !/^[a-z]+$/.test(word))) {
    throw new Error(`${variable} is not a 12- or 24-word phrase`);
  }
  return words;
}

export interface LiveWallet {
  name: WalletName;
  context: BrowserContext;
  page: Page;
  extensionId: string;
  footage: WalletFootage;
  broadcasts: BroadcastMonitor;
  /** Unlock behind a redaction card when the page shows the lock screen. */
  unlockIfLocked(): Promise<void>;
  /** Answer the wallet's password prompt (operation password or an approval lock screen) on `page`. */
  answerPasswordPrompt(page?: Page): Promise<boolean>;
  /** Footage hooks for another page of this wallet (an approval popup, a shop). */
  footageFor(page: Page, role: string): WalletFootage;
}

export interface LiveLane {
  wallets: Readonly<Record<WalletName, LiveWallet>>;
  book: AddressBook;
  ledger: SpendLedger;
  runDir: string;
  backendUrl: string;
  extensionVersion: string;
  startedAt: number;
  /** Append a non-secret line (wallet names, tickers, amounts, txids) to the progress log. */
  progress(line: string): void;
  /** True when spending is permitted; specs skip money legs with the reason otherwise. */
  moneyAllowed(): { ok: true } | { ok: false; reason: string };
}

function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function isSharedBackend(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return !(h === '127.0.0.1' || h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local'));
  } catch {
    return true;
  }
}

function bundleTargets(dir: string, backendUrl: string): boolean {
  const walk = (d: string): boolean =>
    readdirSync(d, { withFileTypes: true }).some((e) => {
      const p = join(d, e.name);
      if (e.isDirectory()) return walk(p);
      return e.name.endsWith('.js') && readFileSync(p, 'utf8').includes(backendUrl);
    });
  return walk(dir);
}

/**
 * The extension under test: EXTENSION_DIST when set (the lane config sets it
 * to the staged zip it verified and unpacked), else the staged zip verified
 * and unpacked here, else the workspace build.
 */
function resolveExtension(scratch: string): { dir: string; version: string } {
  const zip = process.env.E2E_LIVE_EXTENSION_ZIP;
  let dir: string;
  if (zip && !process.env.EXTENSION_DIST) {
    const expected = (process.env.E2E_LIVE_EXTENSION_SHA256 ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error('E2E_LIVE_EXTENSION_ZIP needs E2E_LIVE_EXTENSION_SHA256, the staged hash');
    }
    const actual = createHash('sha256').update(readFileSync(zip)).digest('hex');
    if (actual !== expected) throw new Error('the extension zip does not match its expected sha256; refusing to test other bytes');
    dir = join(scratch, 'extension');
    rmSync(dir, { recursive: true, force: true });
    privateDir(dir);
    const unpacked = spawnSync('unzip', ['-q', resolve(zip), '-d', dir], { stdio: 'ignore' });
    if (unpacked.status !== 0) throw new Error('could not unpack the extension zip');
  } else {
    dir = resolve(process.env.EXTENSION_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension', 'dist'));
  }
  const manifestFile = join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) throw new Error('no extension manifest; set E2E_LIVE_EXTENSION_ZIP or EXTENSION_DIST');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { version?: string };
  if (!manifest.version) throw new Error('extension manifest has no version');
  return { dir, version: manifest.version };
}

const EXPLORER_STUB = (url: string) => `<!doctype html><meta charset="utf-8"><title>Explorer (local stub)</title>
<body style="font-family:sans-serif;padding:24px;background:#111;color:#eee">
<h1 style="font-size:18px">Block explorer, served locally</h1>
<p>The live suite answers explorer links itself, so no transaction id leaves this machine.</p>
<p style="font-family:monospace;word-break:break-all;font-size:12px">${url.replace(/[<>&"]/g, '')}</p></body>`;

/**
 * What a stuck setup page shows, safe to log: visible test ids (names only)
 * and, only when no phrase or password field is on screen, a short excerpt of
 * the visible text (typed values live in fields and are never in it). Mirrors
 * the reviewed demo lane's diagnostic.
 */
async function describeStuckScreen(page: Page): Promise<string> {
  const ids = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'))
        .filter((e) => e.getBoundingClientRect().width > 0)
        .map((e) => e.dataset.testid ?? '')
        .slice(0, 40),
    )
    .catch(() => [] as string[]);
  const sensitive =
    ids.some((id) => /import-word|mnemonic|seed|password/i.test(id)) ||
    (await page.locator('input[type="password"]').count().catch(() => 1)) > 0;
  const text = sensitive
    ? '(withheld on a phrase or password screen)'
    : ((await page.locator('#root').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300);
  return `visible test ids: ${ids.join(', ') || 'none'}; screen text: ${text}`;
}

async function importWallet(
  page: Page,
  extensionId: string,
  words: string[],
  password: string,
): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByTestId('onboarding-import-btn').click({ timeout: 60_000 });
  await page.getByTestId('onboarding-import-warning-continue').click();
  for (let i = 0; i < words.length; i++) await page.getByTestId(`onboarding-import-word-${i}`).fill(words[i]!);
  await page.getByTestId('onboarding-import-continue').click();
  // The wizard fails closed until the backend's sign-up requirements resolve;
  // its retry rebuilds the step with empty fields, so re-enter before each
  // press. Retry only that race: any other refusal counts against the
  // backend's per-wallet restore budget.
  const submit = page.getByTestId('onboarding-set-password-submit');
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByTestId('onboarding-password-input').fill(password);
    await page.getByTestId('onboarding-password-confirm-input').fill(password);
    await submit.click();
    await page.waitForTimeout(3_000);
    if (!(await submit.isVisible().catch(() => false))) break;
    const screen = await page.locator('#root').innerText();
    if (!/sign-up requirements/.test(screen)) break;
    await page.waitForTimeout(5_000);
  }
  await page.getByTestId('onboarding-setup-finish-btn').click({ timeout: 25_000 }).catch(() => {});
  const total = page.getByTestId('home-total-balance');
  // A returning wallet may solve proof of work and rescan before Home shows.
  await total.waitFor({ timeout: 10 * 60_000 }).catch(async () => {
    throw new Error(`import did not reach Home: ${await describeStuckScreen(page)}`);
  });
  for (let i = 0; i < 180 && !/\d/.test((await total.textContent()) ?? ''); i++) await page.waitForTimeout(1_000);
  if (!/\d/.test((await total.textContent()) ?? '')) {
    throw new Error('the wallet never loaded a real balance set from the backend');
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const test = base.extend<{}, { live: LiveLane }>({
  live: [
    async ({}, use) => {
      if (!LIVE_LANE) throw new Error('the live lane runs only with E2E_LIVE=1');
      const backendUrl = process.env.BACKEND_URL;
      if (!backendUrl) throw new Error('set BACKEND_URL (with /api/v1) for the live lane');
      const walletFile = process.env.E2E_LIVE_WALLET_FILE;
      if (!walletFile) throw new Error('set E2E_LIVE_WALLET_FILE to the owner-only phrase file');
      if (process.env.FOOTAGE && !['guarded', 'off'].includes(process.env.FOOTAGE)) {
        throw new Error('FOOTAGE accepts only "guarded" or "off"');
      }

      const label = (process.env.E2E_LIVE_RUN_LABEL ?? 'run-local').replace(/[^a-z0-9-]/gi, '-');
      const scratchRoot = privateDir(join(homedir(), 'Build', 'smirk-e2e', '.scratch', `${LANE}-${process.pid}`));
      const extension = resolveExtension(scratchRoot);
      if (!bundleTargets(extension.dir, backendUrl)) {
        throw new Error('the extension under test does not target BACKEND_URL; refusing to drive a build at another server');
      }
      const runDir = privateDir(
        resolve(process.env.E2E_LIVE_RUN_DIR ?? join(homedir(), 'Build', 'smirk-e2e', `v${extension.version}-${label}`)),
      );
      const laneDir = privateDir(join(runDir, LANE));
      const footageRoot = footageEnabled() ? privateDir(join(runDir, 'footage', LANE)) : null;
      // Without footage, the hooks still write their step timeline here.
      const traceRoot = footageRoot ? undefined : privateDir(join(laneDir, 'trace'));
      const progressFile = join(laneDir, 'progress.log');
      const progress = (line: string) => {
        appendFileSync(progressFile, `${new Date().toISOString()} ${line.replace(/\s+/g, ' ').slice(0, 400)}\n`, { mode: 0o600 });
      };
      const book = new AddressBook(join(laneDir, 'address-book.jsonl'));
      const ledger = new SpendLedger(join(laneDir, 'spend-ledger.jsonl'), book);
      const canary = new SecretCanary();
      const startedAt = Date.now();
      if (footageRoot) {
        writeFootageManifest(footageRoot, {
          startedAt,
          extensionVersion: extension.version,
          backend: new URL(backendUrl).host,
          wallets: WALLET_NAMES,
        });
      }
      progress(`lane start: extension ${extension.version}, backend ${new URL(backendUrl).host}, footage ${footageRoot ? 'guarded' : 'off'}`);

      const contexts: BrowserContext[] = [];
      const footages: WalletFootage[] = [];
      const wallets = {} as Record<WalletName, LiveWallet>;
      try {
        for (const name of WALLET_NAMES) {
          const profile = join(scratchRoot, 'profiles', name);
          rmSync(profile, { recursive: true, force: true });
          privateDir(profile);
          const context = await chromium.launchPersistentContext(profile, {
            headless: !process.env.HEADED,
            channel: 'chromium',
            viewport: VIEWPORT,
            deviceScaleFactor: 2,
            args: [`--disable-extensions-except=${extension.dir}`, `--load-extension=${extension.dir}`],
          });
          contexts.push(context);
          for (const host of EXPLORER_HOSTS) {
            await context.route(`https://${host}/**`, (route) =>
              route.fulfill({ contentType: 'text/html', body: EXPLORER_STUB(route.request().url()) }),
            );
          }
          const broadcasts = await BroadcastMonitor.attach(context, 'observe');
          let [worker] = context.serviceWorkers();
          if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 60_000 });
          const extensionId = new URL(worker.url()).host;
          const page = await context.newPage();

          const password = randomBytes(24).toString('base64url');
          const importStarted = Date.now();
          const words = readWalletPhrase(resolve(walletFile), WALLET_VARIABLE[name]);
          canary.addPhrase(words);
          canary.addExact(password);
          try {
            await importWallet(page, extensionId, words, password);
          } catch (error) {
            // Only importWallet's own messages are logged: Playwright's can quote calls.
            const message = error instanceof Error && error.message.startsWith('import did not reach Home')
              ? error.message
              : 'import failed before Home (details withheld)';
            progress(`${name}: ${message}`);
            throw error;
          } finally {
            words.fill('');
          }
          progress(`${name}: imported and showing Home`);

          let popupCount = 0;
          const footage = createFootage({ name, page, canary, footageRoot, ...(traceRoot ? { traceRoot } : {}) });
          footage.spanBefore('Wallet import: phrase and password entry are never recorded', importStarted, Date.now());
          footages.push(footage);

          const popupFootage = new Map<Page, WalletFootage>();
          const footageFor = (target: Page, role: string): WalletFootage => {
            if (target === page) return footage;
            let f = popupFootage.get(target);
            if (!f) {
              popupCount += 1;
              f = createFootage({
                name: `${name}-${role}-${popupCount}`,
                page: target,
                canary,
                footageRoot,
                ...(traceRoot ? { traceRoot } : {}),
              });
              popupFootage.set(target, f);
              footages.push(f);
            }
            return f;
          };
          // Approval windows and other pages this wallet opens are recorded
          // too, through the same guard, from the moment they appear.
          context.on('page', (p) => {
            if (p !== page) footageFor(p, 'popup');
          });

          const answerPasswordPrompt = async (target: Page = page): Promise<boolean> => {
            const lock = target.getByTestId('lockscreen-password-input');
            const op = target.getByTestId('operation-password');
            const which = (await op.isVisible().catch(() => false)) ? 'op' : (await lock.isVisible().catch(() => false)) ? 'lock' : null;
            if (!which) return false;
            const hooks = footageFor(target, 'popup');
            await hooks.secret('Password entry (redacted)', async () => {
              if (which === 'op') {
                await hooks.typeSecret(op, password);
                await target.getByTestId('operation-password-confirm').click();
                await op.waitFor({ state: 'detached', timeout: 60_000 });
              } else {
                await hooks.typeSecret(lock, password);
                await target.getByTestId('lockscreen-unlock-btn').click();
                await target.getByTestId('lockscreen-root').waitFor({ state: 'detached', timeout: 120_000 });
              }
            });
            return true;
          };

          wallets[name] = {
            name,
            context,
            page,
            extensionId,
            footage,
            broadcasts,
            footageFor,
            answerPasswordPrompt,
            unlockIfLocked: async () => {
              if (await page.getByTestId('lockscreen-root').isVisible().catch(() => false)) {
                await answerPasswordPrompt(page);
              }
            },
          };
        }

        await use({
          wallets,
          book,
          ledger,
          runDir,
          backendUrl,
          extensionVersion: extension.version,
          startedAt,
          progress,
          moneyAllowed: () => {
            if (process.env.E2E_LIVE_MONEY !== '1') {
              return { ok: false, reason: 'live-money gate: set E2E_LIVE_MONEY=1 to broadcast (SPENDS REAL FUNDS)' };
            }
            if (isSharedBackend(backendUrl) && process.env.ALLOW_PROD_WRITES !== '1') {
              return { ok: false, reason: 'shared backend: set ALLOW_PROD_WRITES=1 to write to it' };
            }
            return { ok: true };
          },
        });
      } finally {
        progress('lane teardown: stopping recorders and closing browsers');
        for (const f of footages) await f.stop().catch(() => {});
        for (const c of contexts) await c.close().catch(() => {});
        rmSync(scratchRoot, { recursive: true, force: true });
        progress('lane end: profiles deleted');
      }
    },
    { scope: 'worker', timeout: 45 * 60_000 },
  ],
});

export { expect } from '@playwright/test';
