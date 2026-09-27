import { chromium, type BrowserContext } from '@playwright/test';
import { test as base } from './private-test.js';
import { assertPrivateCapture, sanitizeTestErrors } from '../capture-policy.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Built MV3 extension. `EXTENSION_DIST` overrides (e.g. a local-backend build). */
const EXTENSION_DIST =
  process.env.EXTENSION_DIST ?? join(__dirname, '..', '..', 'extension', 'dist');

import { Footage } from './footage.js';

// Legacy exports remain for closed marketing specs. Capture cannot be enabled
// in a wallet context; a future demo needs its own reviewed secret-free fixture.
export const MARKETING_SHOTS = false;
export const CAPTURE_VIDEO = false;
export const MARKETING_VARIANT = process.env.MARKETING_VARIANT === 'phone' ? 'phone' : 'popup';

/**
 * Load the built extension into a persistent Chromium context and expose its id.
 *
 * MV3 background is a service worker, which Chromium only runs when extensions
 * are actually loaded; hence `launchPersistentContext` with `--load-extension`
 * (a normal `browser.newContext()` can't host an extension). Headless-with-
 * extensions needs the new headless mode; `HEADED=1` forces a visible window for
 * debugging.
 */
export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  /** Mark moments worth showing; see fixtures/footage.ts. */
  footage: Footage;
}>({
  context: async ({ trace, screenshot, video }, use, testInfo) => {
    assertPrivateCapture({ trace, screenshot, video });
    if (!existsSync(join(EXTENSION_DIST, 'manifest.json'))) {
      throw new Error(
        `extension build not found at ${EXTENSION_DIST}; run \`npm run build:chrome -w @smirk/extension\` first`,
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
    try {
      await use(context);
    } finally {
      sanitizeTestErrors(testInfo);
      await context.close();
    }
  },

  footage: async ({}, use) => {
    await use(new Footage());
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

/**
 * True when the target backend is a SHARED / production host (not loopback).
 * Fails safe: an unparseable URL is treated as shared.
 */
export function isSharedBackend(): boolean {
  try {
    const h = new URL(BACKEND_URL).hostname;
    return !(h === '127.0.0.1' || h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local'));
  } catch {
    return true;
  }
}

/**
 * Whether a spec that WRITES real rows (registers a new wallet, mints an invoice)
 * should self-skip. The e2e suite normally runs against a local/disposable
 * `smirk-backend-core`, so by default a write spec is refused on a shared/prod
 * host: you can't pollute production by accident. You CAN opt in deliberately
 * (a real prod smoke check) with `ALLOW_PROD_WRITES=1`.
 */
export function skipDestructiveOnShared(): boolean {
  return isSharedBackend() && !process.env.ALLOW_PROD_WRITES;
}
