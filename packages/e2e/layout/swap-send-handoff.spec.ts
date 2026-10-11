import { test, expect, chromium, type BrowserContext, type Route } from '@playwright/test';
import { build, type Plugin } from 'esbuild';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SubmittedDeposit } from './swap-send-harness';

/**
 * A THORChain deposit handed from the Swap wizard to Send arrives intact.
 *
 * Regression for the v0.3.1 candidate (live run 2026-10-10, THORChain BTC to
 * LTC): after the binding re-quote the deposit step showed 0.00015 BTC, but
 * "Open Send → pre-filled" opened Send on its coin chooser with nothing
 * filled in. The handler writes three states back to back (the swap wizard's
 * status step, the Send draft, the route). chrome.storage.local announces
 * each write to the writing page before the write's promise settles and
 * returns keys sorted, so the store took the echo of its first write for a
 * change from another window, put it back in its cache, and built the route
 * change on that stale copy: the Send draft was gone before Send mounted.
 *
 * That defect lives in the browser's storage events, so this spec loads the
 * popup's real SwapRouter and SendWizard (swap-send-harness.tsx) as an
 * unpacked extension page and drives them against the recorded THORChain
 * mainnet fixture. Every request is answered here; nothing reaches a real
 * host, and nothing is signed: Send's submit only runs the popup's memo check.
 *
 * Chromium only (it loads an extension). Run:
 *   npm run test:layout -w @smirk/e2e -- swap-send-handoff --project chromium
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const extDir = join(here, '..', 'test-results', 'swap-send-harness');
const BACKEND_HOST = 'api.smirk.cash';
const GATEWAY_HOST = 'gateway.liquify.com';

const THOR = JSON.parse(
  readFileSync(join(root, 'packages', 'swap', 'src', '__tests__', 'fixtures', 'thorchain', 'mainnet-btc-ltc.json'), 'utf8'),
);
const BTC_VAULT: string = THOR.inbound_addresses.find((a: { chain: string }) => a.chain === 'BTC').address;
const OWN_LTC = 'ltc1qp6r3vr50h7ehdq5qw2k8alzqwjq76xd5ux38mz';

/**
 * Workspace packages bundled from their sources, so the spec tests this tree
 * and never a stale dist/. The WASM bundle is not needed on this path and is
 * not built everywhere; any call into its stand-in throws.
 */
function workspaceSources(): Plugin {
  const byName = new Map<string, string>();
  for (const dir of readdirSync(join(root, 'packages'))) {
    const manifest = join(root, 'packages', dir, 'package.json');
    const entry = join(root, 'packages', dir, 'src', 'index.ts');
    if (!existsSync(manifest) || !existsSync(entry)) continue;
    byName.set((JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name, entry);
  }
  return {
    name: 'workspace-sources',
    setup(b) {
      b.onResolve({ filter: /^@smirk\/wasm(\/.*)?$/ }, () => ({ path: 'wasm-stub', namespace: 'wasm-stub' }));
      b.onLoad({ filter: /.*/, namespace: 'wasm-stub' }, () => ({
        contents:
          'const fail = () => { throw new Error("wasm stub called"); };' +
          'module.exports = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? false : new Proxy(fail, { get: () => fail })) });',
        loader: 'js',
      }));
      b.onResolve({ filter: /^@(smirk|such-software)\/[a-z0-9-]+$/ }, (args) => {
        const entry = byName.get(args.path);
        return entry ? { path: entry } : undefined;
      });
    },
  };
}

test.beforeAll(async ({ browserName }) => {
  if (browserName !== 'chromium') return;
  rmSync(extDir, { recursive: true, force: true });
  mkdirSync(extDir, { recursive: true });
  await build({
    entryPoints: [join(here, 'swap-send-harness.tsx')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    outfile: join(extDir, 'harness.js'),
    logLevel: 'silent',
    define: {
      'import.meta.env': JSON.stringify({ VITE_TROCADOR_API_KEY: 'harness-dummy-key', MODE: 'production', DEV: false, PROD: true }),
    },
    plugins: [workspaceSources()],
  });
  writeFileSync(
    join(extDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Smirk swap to Send harness',
      version: '0.0.1',
      permissions: ['storage'],
      background: { service_worker: 'worker.js' },
    }),
  );
  // An idle worker: it gives the page its extension origin and its id.
  writeFileSync(join(extDir, 'worker.js'), '// idle\n');
  writeFileSync(
    join(extDir, 'harness.html'),
    '<!doctype html><html lang="en"><head><meta charset="UTF-8" />' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>' +
      '<body><div id="root"></div><script src="harness.js"></script></body></html>',
  );
});

/**
 * Answer every request: the wallet server with a capabilities document that
 * offers THORChain, THORChain from the recorded fixture. Quotes keep the
 * recorded fees, accept the amount asked, name the requested destination in
 * their memo, and expire ten minutes from now. Each quote request is kept.
 */
async function serve(context: BrowserContext): Promise<{ quotes: URLSearchParams[]; hosts: Set<string> }> {
  const quotes: URLSearchParams[] = [];
  const hosts = new Set<string>();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  await context.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    hosts.add(url.host);
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.host === BACKEND_HOST) {
      if (url.pathname.endsWith('/capabilities')) {
        return json(route, {
          version: 'harness',
          contract_version: 1,
          features: { tips: false, prices: false, grin_relay: false, nostr_identity: false, nostr_relay: false },
          swaps: { thorchain: { enabled: true }, nonlogs: { enabled: false, assets: [] } },
        });
      }
      return json(route, { error: 'not in this harness' }, 404);
    }
    if (url.host === GATEWAY_HOST) {
      const path = url.pathname.replace(/^\/chain\/thorchain_api/, '');
      if (path === '/thorchain/pools') return json(route, THOR.pools);
      if (path === '/thorchain/inbound_addresses') return json(route, THOR.inbound_addresses);
      if (path === '/thorchain/quote/swap') {
        const q = url.searchParams;
        quotes.push(q);
        if (q.get('from_asset') !== 'BTC.BTC' || q.get('to_asset') !== 'LTC.LTC') return json(route, { message: 'pair not in this harness' }, 400);
        const destination = q.get('destination');
        return json(route, {
          ...THOR.quote_btc_to_ltc,
          recommended_min_amount_in: '6201',
          expiry: Math.floor(Date.now() / 1000) + 600,
          memo: destination ? `=:l:${destination}:1` : THOR.quote_btc_to_ltc.memo,
        });
      }
      return json(route, { message: 'not in this harness' }, 404);
    }
    return json(route, { error: 'unexpected host' }, 404);
  });
  return { quotes, hosts };
}

test('Open Send after a THORChain confirm prefills the binding deposit, and Send signs exactly it with its memo', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'loads an unpacked extension, which only Chromium does');
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'smirk-swap-send-')), {
    headless: !process.env.HEADED,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  try {
    const { quotes, hosts } = await serve(context);
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/harness.html`);
    await page.waitForFunction(() => window.__mounted === true);

    // THORChain: one tap checks it, the next opens its wizard.
    const card = page.getByTestId('swap-provider-thorchain');
    await card.click();
    await expect(card).toContainText('Live now', { timeout: 15_000 });
    await card.click();
    const step = page.getByTestId('swap-wizard-step');
    await expect(step).toHaveText('1/4');
    await page.getByTestId('swap-pair-from-BTC').click();
    await page.getByTestId('swap-pair-to-LTC').click();
    await page.getByTestId('swap-pair-amount').fill('0.00015');
    await page.getByTestId('swap-pair-get-quote').click();
    await expect(step).toHaveText('2/4', { timeout: 15_000 });

    // Confirm quotes again with the destination: that binding quote is the deposit.
    await page.getByTestId('swap-quote-use-my-to-address').click();
    await expect(page.getByTestId('swap-quote-to-address')).toHaveValue(OWN_LTC);
    await page.getByTestId('swap-quote-confirm').click();
    await expect(step).toHaveText('3/4', { timeout: 15_000 });
    const binding = quotes.filter((q) => q.get('destination') === OWN_LTC);
    expect(binding, 'one binding quote, made with the destination').toHaveLength(1);
    const bindingSat = binding[0]!.get('amount');
    expect(bindingSat, 'the binding quote is for the amount quoted (BTC counts in sats)').toBe('15000');
    await expect(page.getByTestId('swap-deposit-amount')).toHaveText('0.00015 BTC');

    // The handoff: Send opens on its amount step, holding the binding deposit.
    await page.getByTestId('swap-deposit-open-send').click();
    const amount = page.getByTestId('send-amount-input');
    await expect(amount, 'Send opens on its amount step, not on the coin chooser').toBeVisible({ timeout: 15_000 });
    await expect(amount).toHaveValue('0.00015');

    // Review, then submit: the popup's memo check decides what would be signed.
    await page.getByTestId('send-compose-continue').click();
    await page.getByTestId('send-review-submit').click();
    await expect.poll(() => page.evaluate(() => window.__submitted.length), { timeout: 15_000 }).toBe(1);
    const [sent] = (await page.evaluate(() => window.__submitted)) as SubmittedDeposit[];
    expect(sent).toEqual({
      fromAssetId: 'btc',
      toAddress: BTC_VAULT,
      amountAtomic: bindingSat,
      decision: 'send-with-memo',
      memo: `=:l:${OWN_LTC}:1`,
    });
    expect([...hosts].sort(), 'only the wallet server and the THORChain gateway were asked').toEqual([BACKEND_HOST, GATEWAY_HOST].sort());
  } finally {
    await context.close();
  }
});
