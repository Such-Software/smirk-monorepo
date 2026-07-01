import { test as base, chromium, type BrowserContext } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Built MV3 extension. `EXTENSION_DIST` overrides (e.g. a local-backend build). */
const EXTENSION_DIST =
  process.env.EXTENSION_DIST ?? join(__dirname, '..', '..', 'extension', 'dist');

/**
 * Load the built extension into a persistent Chromium context and expose its id.
 *
 * MV3 background is a service worker, which Chromium only runs when extensions
 * are actually loaded — hence `launchPersistentContext` with `--load-extension`
 * (a normal `browser.newContext()` can't host an extension). Headless-with-
 * extensions needs the new headless mode; `HEADED=1` forces a visible window for
 * debugging.
 */
export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    if (!existsSync(join(EXTENSION_DIST, 'manifest.json'))) {
      throw new Error(
        `extension build not found at ${EXTENSION_DIST} — run \`npm run build:chrome -w @smirk/extension\` first`,
      );
    }
    const context = await chromium.launchPersistentContext('', {
      headless: process.env.HEADED ? false : true,
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${EXTENSION_DIST}`,
        `--load-extension=${EXTENSION_DIST}`,
        '--no-sandbox',
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // The background service worker's URL is chrome-extension://<id>/... .
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(sw.url()).host;
    await use(extensionId);
  },
});

export const expect = test.expect;

/** The instance under test (default: local smirk-backend-core). */
export const BACKEND_URL = process.env.BACKEND_URL ?? 'http://127.0.0.1:8080/api/v1';
