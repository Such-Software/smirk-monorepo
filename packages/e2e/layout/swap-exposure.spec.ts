import { test, expect, type Page, type Route } from '@playwright/test';
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Opening the Swap tab is not consent to contact a third party.
 *
 * Regression for the v0.3.1 candidate: on mount the Swap tab asked THORChain's
 * public gateway (gateway.liquify.com) for its pools and inbound addresses, and
 * the WOW/GRIN panel asked neroswap.com for three prices, from the user's IP,
 * before the user chose anything. Route state persists, so reopening the popup
 * onto Swap repeated it. v0.3.0 made no such request.
 *
 * The harness renders the extension's real SwapRouter in a plain page. Every
 * request is answered here: the wallet's own backend (api.smirk.cash) with a
 * minimal capabilities document, THORChain from the recorded mainnet fixture,
 * Neroswap with a price. The spec requires silence toward anyone but the
 * backend until the user taps, and the request after each tap.
 *
 * Run: npm run test:layout -w @smirk/e2e (build the workspace libraries first).
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const outDir = join(here, '..', 'test-results', 'swap-harness');
const pageFile = join(outDir, 'index.html');
const BACKEND_HOST = 'api.smirk.cash';

const THOR = JSON.parse(
  readFileSync(join(root, 'packages', 'swap', 'src', '__tests__', 'fixtures', 'thorchain', 'mainnet-btc-ltc.json'), 'utf8'),
);

test.beforeAll(async () => {
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [join(here, 'swap-harness.tsx')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    outfile: join(outDir, 'harness.js'),
    logLevel: 'silent',
    // A production-like build: a Trocador key present (a dummy), no backend override.
    define: {
      'import.meta.env': JSON.stringify({ VITE_TROCADOR_API_KEY: 'harness-dummy-key', MODE: 'production', DEV: false, PROD: true }),
    },
    plugins: [
      {
        // The WASM bundle is not needed to render the Swap tab, and is not
        // built everywhere this suite runs. Any call into it fails loudly.
        name: 'wasm-stub',
        setup(b) {
          b.onResolve({ filter: /^@smirk\/wasm(\/.*)?$/ }, () => ({ path: 'wasm-stub', namespace: 'wasm-stub' }));
          b.onLoad({ filter: /.*/, namespace: 'wasm-stub' }, () => ({
            contents:
              'const fail = () => { throw new Error("wasm stub called"); };' +
              'module.exports = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? false : new Proxy(fail, { get: () => fail })) });',
            loader: 'js',
          }));
        },
      },
    ],
  });
  writeFileSync(
    pageFile,
    '<!doctype html><html lang="en"><head><meta charset="UTF-8" />' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>' +
      '<body><div id="root"></div><script src="harness.js"></script></body></html>',
  );
});

/** Answer every network request, and record the host and path of each. */
async function serve(page: Page, opts: { thorchainDown?: boolean } = {}): Promise<{ hosts: string[]; paths: string[] }> {
  const hosts: string[] = [];
  const paths: string[] = [];
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    hosts.push(url.host);
    paths.push(`${url.host}${url.pathname}`);
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' },
      });
    }
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
    if (url.host === 'gateway.liquify.com') {
      if (opts.thorchainDown) return json(route, { message: 'upstream unavailable' }, 503);
      if (url.pathname.endsWith('/thorchain/pools')) return json(route, THOR.pools);
      if (url.pathname.endsWith('/thorchain/inbound_addresses')) return json(route, THOR.inbound_addresses);
      return json(route, { message: 'not in this harness' }, 404);
    }
    if (url.host === 'neroswap.com') return json(route, { consolidated: { bestBid: 0.0000012, bestAsk: 0.0000013 } });
    return json(route, { error: 'unexpected host' }, 404);
  });
  return { hosts, paths };
}

/** THORChain availability checks made so far: each one reads the pools. */
const poolChecks = (paths: string[]) => paths.filter((p) => p.endsWith('/thorchain/pools')).length;

const thirdParty = (hosts: string[]) => [...new Set(hosts.filter((h) => h !== BACKEND_HOST))];

test('opening the Swap tab contacts no one but the wallet server; each tap contacts its own provider', async ({ page }) => {
  const { hosts } = await serve(page);
  await page.goto(pathToFileURL(pageFile).href);
  await page.waitForFunction(() => window.__mounted === true);
  const thorCard = page.getByTestId('swap-provider-thorchain');
  await expect(thorCard).toBeVisible();
  // Long enough for any mount effect, and for a deferred one to fire.
  await page.waitForTimeout(2500);
  expect(thirdParty(hosts), 'no third party before the user acts').toEqual([]);

  // The THORChain card says what a tap contacts, and the tap asks THORChain.
  await expect(thorCard).toContainText('gateway.liquify.com');
  await thorCard.click();
  await expect(thorCard).toContainText('Live now', { timeout: 10_000 });
  expect(thirdParty(hosts)).toEqual(['gateway.liquify.com']);

  // Prices load on their own tap.
  await page.getByTestId('swap-where-to-trade-show-prices').click();
  await expect(page.getByTestId('swap-where-to-trade')).toContainText('Best DEX prices', { timeout: 10_000 });
  expect(thirdParty(hosts).sort()).toEqual(['gateway.liquify.com', 'neroswap.com']);
});

test('a popup reopened onto a THORChain swap checks THORChain once, and does not retry a failure by itself', async ({ page }) => {
  // Resuming the swap is the user's choice of provider, so one check is fine.
  // A failed one must wait for a tap, not loop against the gateway.
  const { hosts, paths } = await serve(page, { thorchainDown: true });
  await page.goto(`${pathToFileURL(pageFile).href}?restore=thorchain`);
  await page.waitForFunction(() => window.__mounted === true);
  await expect.poll(() => poolChecks(paths), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(4000);
  expect(poolChecks(paths), 'one check, no automatic retry').toBe(1);
  expect(thirdParty(hosts)).toEqual(['gateway.liquify.com']);
});
