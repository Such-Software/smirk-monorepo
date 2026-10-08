import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Popup layout, in Chromium AND Firefox.
 *
 * Regression for the Firefox store build of v0.3.0: "the wallet window seems
 * too small, cannot click the top row buttons". In a Firefox browser-action
 * popup `window.outerWidth` is the whole browser window (the popup is a
 * <browser> in a panel of the main window's document), and the shell decided
 * pop-out versus popup from `outerWidth`. Firefox's 380px popup therefore got
 * the wide sidebar layout, where the header actions overflowed the 200px
 * sidebar and sat under the main pane.
 *
 * Each case renders the real AppShell with the real popup stylesheet at the
 * popup's size, makes `outerWidth` report a wide browser window the way Firefox
 * does, and requires every header control to be on screen and to receive a
 * click at its centre.
 */

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test-results', 'layout-harness');
const pageFile = join(outDir, 'index.html');

test.beforeAll(async () => {
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [join(here, 'harness.tsx')],
    bundle: true,
    // A classic script: browsers refuse module scripts from file:// (origin null).
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    outfile: join(outDir, 'harness.js'),
    logLevel: 'silent',
  });
  const css = readFileSync(join(here, '..', '..', 'extension', 'src', 'popup', 'styles.css'), 'utf8');
  writeFileSync(join(outDir, 'popup.css'), css);
  writeFileSync(
    pageFile,
    '<!doctype html><html lang="en"><head><meta charset="UTF-8" />' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
      '<link rel="stylesheet" href="popup.css" /></head>' +
      '<body><div id="root"></div><script src="harness.js"></script></body></html>',
  );
});

const HEADER_CONTROLS = ['Switch identity', 'Open in a browser tab', 'Open in its own window', 'Lock wallet'];

async function open(page: Page, opts: { firefoxOuterWidth?: number }) {
  if (opts.firefoxOuterWidth !== undefined) {
    const w = opts.firefoxOuterWidth;
    await page.addInitScript((outer: number) => {
      Object.defineProperty(window, 'outerWidth', { configurable: true, get: () => outer });
    }, w);
  }
  await page.goto(pathToFileURL(pageFile).href);
  await expect(page.getByTestId('app-shell-root')).toBeVisible();
}

async function expectHeaderClickable(page: Page) {
  await expect(page.locator('header')).toHaveCount(1);
  await expect(page.locator('aside')).toHaveCount(0);
  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  for (const label of HEADER_CONTROLS) {
    const button = page.getByRole('button', { name: label, exact: true });
    await expect(button, `${label} is rendered`).toBeVisible();
    const box = await button.boundingBox();
    expect(box, `${label} has a box`).not.toBeNull();
    expect(box!.x, `${label} starts on screen`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${label} ends on screen`).toBeLessThanOrEqual(viewport.w);
    const hit = await page.evaluate(
      ({ x, y, name }) => {
        const el = document.elementFromPoint(x, y);
        const target = el?.closest('button');
        return target?.getAttribute('aria-label') === name;
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, name: label },
    );
    expect(hit, `${label} receives a click at its centre`).toBe(true);
  }
  // A real click lands on the lock control.
  await page.getByRole('button', { name: 'Lock wallet', exact: true }).click();
  expect(await page.evaluate(() => window.__shellClicks)).toContain('lock');
}

const POPUP_CASES = [
  { name: 'popup 380x600, browser window 1440 wide (Firefox outerWidth)', width: 380, height: 600, outer: 1440, scale: 1 },
  { name: 'popup 380x600 at 2x (high DPI)', width: 380, height: 600, outer: 1920, scale: 2 },
  { name: 'popup 380x600 at 1.25x (Windows default scaling)', width: 380, height: 600, outer: 1536, scale: 1.25 },
];

for (const c of POPUP_CASES) {
  test(`header controls are on screen and clickable: ${c.name}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: c.width, height: c.height },
      deviceScaleFactor: c.scale,
    });
    const page = await context.newPage();
    await open(page, { firefoxOuterWidth: c.outer });
    // Optional evidence, taken before asserting so a failing layout is captured too.
    const shots = process.env.LAYOUT_SHOTS_DIR;
    if (shots) {
      await page.screenshot({
        path: join(shots, `${test.info().project.name}-${c.width}x${c.height}@${c.scale}.png`),
      });
    }
    await expectHeaderClickable(page);
    await context.close();
  });
}

test('the popup body keeps its 380x600 size', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 380, height: 600 } });
  const page = await context.newPage();
  await open(page, { firefoxOuterWidth: 1440 });
  const size = await page.evaluate(() => {
    const r = document.body.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  expect(size.w).toBeGreaterThanOrEqual(380);
  expect(size.h).toBeGreaterThanOrEqual(600);
  await context.close();
});

test('a wide window still gets the sidebar layout', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  await open(page, {});
  await expect(page.locator('aside')).toHaveCount(1);
  await expect(page.locator('header')).toHaveCount(0);
  await context.close();
});
