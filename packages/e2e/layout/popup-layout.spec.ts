import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Popup layout, in Chromium, Firefox and Firefox with LibreWolf-style
 * resistFingerprinting (project `firefox-rfp`).
 *
 * Regression for the Firefox store build of v0.3.0 (reported on LibreWolf with
 * the WinXP theme): "the wallet window seems too small, cannot click the top
 * row buttons". In a Firefox browser-action popup `window.outerWidth` is the
 * whole browser window (the popup is a <browser> in a panel of the main
 * window's document), and the shell chose pop-out versus popup from
 * `outerWidth`. The 380px popup got the wide sidebar layout; the header actions
 * overflowed the 200px sidebar, and a positioned balance card (WinXP) painted
 * over them.
 *
 * Each case renders the real AppShell, popup stylesheet and theme engine at the
 * popup's size, makes `outerWidth` report a wide browser window as Firefox
 * does, and requires the compact layout and every header control to be on
 * screen and to receive a click at its centre.
 */

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test-results', 'layout-harness');
const pageFile = join(outDir, 'index.html');

const THEMES = ['default', 'win95', 'winxp', 'amiga', 'ios-classic', 'gameboy', 'n64'];
const HEADER_CONTROLS = ['Switch identity', 'Open in a browser tab', 'Open in its own window', 'Lock wallet'];

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

async function open(
  page: Page,
  opts: { firefoxOuterWidth?: number; theme?: string; layout?: 'auto' | 'popup' | 'wide' },
) {
  if (opts.firefoxOuterWidth !== undefined) {
    await page.addInitScript((outer: number) => {
      Object.defineProperty(window, 'outerWidth', { configurable: true, get: () => outer });
    }, opts.firefoxOuterWidth);
  }
  const url = new URL(pathToFileURL(pageFile).href);
  if (opts.theme) url.searchParams.set('theme', opts.theme);
  if (opts.layout) url.searchParams.set('layout', opts.layout);
  await page.goto(url.href);
  await expect(page.getByTestId('app-shell-root')).toBeVisible();
}

async function shot(page: Page, name: string) {
  const dir = process.env.LAYOUT_SHOTS_DIR;
  if (dir) await page.screenshot({ path: join(dir, `${test.info().project.name}-${name}.png`) });
}

async function expectCompactLayoutWithClickableHeader(page: Page) {
  await expect(page.getByTestId('app-shell-root')).toHaveAttribute('data-layout', 'popup');
  await expect(page.locator('header')).toHaveCount(1);
  await expect(page.locator('aside')).toHaveCount(0);
  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  for (const label of HEADER_CONTROLS) {
    const button = page.getByRole('button', { name: label, exact: true });
    await expect(button, `${label} is rendered`).toBeVisible();
    const box = await button.boundingBox();
    expect(box, `${label} has a box`).not.toBeNull();
    expect(box!.x, `${label} starts on screen`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${label} ends on screen`).toBeLessThanOrEqual(viewport.w + 0.5);
    const hit = await page.evaluate(
      ({ x, y, name }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') === name,
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, name: label },
    );
    expect(hit, `${label} receives a click at its centre (nothing painted over it)`).toBe(true);
  }
  // The balance card sits below the header, not over it.
  const header = await page.locator('header').boundingBox();
  const card = await page.getByTestId('balance-card').boundingBox();
  expect(card!.y, 'balance card starts below the header').toBeGreaterThanOrEqual(header!.y + header!.height - 0.5);
  // A real click reaches the lock control.
  await page.getByRole('button', { name: 'Lock wallet', exact: true }).click();
  expect(await page.evaluate(() => window.__shellClicks)).toContain('lock');
}

const SCALES = [
  { name: '1x', outer: 1440, scale: 1 },
  { name: '1.25x (Windows default scaling)', outer: 1536, scale: 1.25 },
  { name: '2x (high DPI)', outer: 1920, scale: 2 },
];

for (const s of SCALES) {
  test(`popup 380x600 at ${s.name}: compact layout, header clickable`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 380, height: 600 }, deviceScaleFactor: s.scale });
    const page = await context.newPage();
    await open(page, { firefoxOuterWidth: s.outer });
    await shot(page, `default-380x600@${s.scale}`);
    await expectCompactLayoutWithClickableHeader(page);
    await context.close();
  });
}

for (const theme of THEMES) {
  test(`popup 380x600, theme ${theme}: compact layout, header clickable, theme applied`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 380, height: 600 } });
    const page = await context.newPage();
    await open(page, { firefoxOuterWidth: 1440, theme });
    await shot(page, `${theme}-380x600`);
    await expectCompactLayoutWithClickableHeader(page);
    // The chosen theme is applied (not the browser's native look): its class is
    // on <html>, and color-scheme is declared so forced light/dark preferences
    // (resistFingerprinting) cannot restyle UA parts.
    const applied = await page.evaluate(() => ({
      cls: document.documentElement.className,
      scheme: getComputedStyle(document.documentElement).colorScheme,
    }));
    expect(applied.cls).toContain(`smirk-theme-${theme}`);
    expect(['dark', 'light']).toContain(applied.scheme);
    await context.close();
  });
}

test('an action popup stays compact even when the viewport misreports wide', async ({ browser }) => {
  // Firefox's popup viewport is unsettled while it opens; the extension passes
  // layout=popup from context, which must win over any measurement.
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await open(page, { firefoxOuterWidth: 1440, layout: 'popup' });
  await expect(page.getByTestId('app-shell-root')).toHaveAttribute('data-layout', 'popup');
  await expect(page.locator('aside')).toHaveCount(0);
  await context.close();
});

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

test('a wide window (tab, desktop) still gets the sidebar layout', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  await open(page, {});
  await expect(page.getByTestId('app-shell-root')).toHaveAttribute('data-layout', 'wide');
  await expect(page.locator('aside')).toHaveCount(1);
  await expect(page.locator('header')).toHaveCount(0);
  await context.close();
});
