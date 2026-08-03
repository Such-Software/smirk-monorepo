import { test as base, chromium, type BrowserContext } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Built MV3 extension. `EXTENSION_DIST` overrides (e.g. a local-backend build). */
const EXTENSION_DIST =
  process.env.EXTENSION_DIST ?? join(__dirname, '..', '..', 'extension', 'dist');

/**
 * `CAPTURE_VIDEO=1` records EVERY page in the context (popup, approval window, dapp
 * page) to `CAPTURE_VIDEO_DIR` (default `packages/e2e/videos/`), not just on failure —
 * so an e2e run doubles as raw demo-video capture of real flows (payment popup, connect,
 * operator console) that feeds the such-graphics branding pipeline. Default off: normal
 * runs keep only the config's on-failure video. Video needs a headed/new-headless
 * Chromium, which the extension context already uses.
 */
import { homedir } from 'node:os';
import { Footage } from './footage.js';

export const CAPTURE_VIDEO = ['1', 'on', 'true', 'yes'].includes(
  (process.env.CAPTURE_VIDEO ?? '').toLowerCase(),
);
// Captures are regenerable, so they land under `~/Build/smirk-monorepo/e2e/`,
// never in the worktree. `CAPTURE_VIDEO_DIR` overrides. Raw captures are
// intermediates; promote finished clips with `scripts/process-footage.mjs
// --promote`, which a human runs after watching them.
const VIDEO_DIR =
  process.env.CAPTURE_VIDEO_DIR ??
  join(homedir(), 'Build', 'smirk-monorepo', 'e2e', 'videos');

/**
 * Capture at a MOBILE-PORTRAIT size by default. The wallet popup + the dapp approval
 * window are already phone-shaped, so a portrait viewport yields clean vertical clips
 * ideal for mobile / short-form content (App Store previews, Reels/TikTok) — feeding
 * the such-graphics pipeline (which upscales to the canonical 1920x1080@60 with brand
 * framing). Override with CAPTURE_VIDEO_W / CAPTURE_VIDEO_H for a different aspect.
 */
// MUST be >= 481px wide. styles.css locks html/body to a fixed 380x600 popup
// and only switches to `100%/100vh` above a 481px breakpoint, so a narrower
// capture leaves the wallet letterboxed at 600px inside a taller frame: dead
// grey space below, and the bottom nav stranded mid-video. 500x900 clears the
// breakpoint so the layout fills, while staying portrait for short-form.
const VIDEO_SIZE = {
  width: Number(process.env.CAPTURE_VIDEO_W ?? 500),
  height: Number(process.env.CAPTURE_VIDEO_H ?? 900),
};

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
  /** Mark moments worth showing; see fixtures/footage.ts. */
  footage: Footage;
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
      // Demo capture: record every page (popup, approval window, dapp) at a
      // mobile-portrait viewport so the clips are phone-shaped. Off by default.
      ...(CAPTURE_VIDEO
        ? { recordVideo: { dir: VIDEO_DIR, size: VIDEO_SIZE }, viewport: VIDEO_SIZE }
        : {}),
    });
    await use(context);
    await context.close();
  },

  footage: async ({ context }, use, testInfo) => {
    const f = new Footage(testInfo);
    // Track pages as they open; see the note in footage.ts on why reading
    // context.pages() at teardown loses almost every video.
    context.on('page', (p) => f.track(p));
    for (const p of context.pages()) f.track(p);
    await use(f);
    // Written after the test body so page.video() paths have resolved.
    await f.writeManifest(context);
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
 * host — you can't pollute production by accident. You CAN opt in deliberately
 * (a real prod smoke check) with `ALLOW_PROD_WRITES=1`.
 */
export function skipDestructiveOnShared(): boolean {
  return isSharedBackend() && !process.env.ALLOW_PROD_WRITES;
}
