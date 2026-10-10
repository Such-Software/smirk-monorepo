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
  opts: { firefoxOuterWidth?: number; theme?: string; layout?: 'auto' | 'popup' | 'wide'; brand?: 'text' },
) {
  if (opts.firefoxOuterWidth !== undefined) {
    await page.addInitScript((outer: number) => {
      Object.defineProperty(window, 'outerWidth', { configurable: true, get: () => outer });
    }, opts.firefoxOuterWidth);
  }
  const url = new URL(pathToFileURL(pageFile).href);
  if (opts.theme) url.searchParams.set('theme', opts.theme);
  if (opts.layout) url.searchParams.set('layout', opts.layout);
  if (opts.brand) url.searchParams.set('brand', opts.brand);
  await page.goto(url.href);
  await expect(page.getByTestId('app-shell-root')).toBeVisible();
}

async function shot(page: Page, name: string) {
  const dir = process.env.LAYOUT_SHOTS_DIR;
  if (dir) await page.screenshot({ path: join(dir, `${test.info().project.name}-${name}.png`) });
}

/**
 * The header wordmark is either hidden (the logo alone names the app) or on one
 * unclipped line, and the brand never reaches the identity chip. The v0.3.1
 * release candidate wrapped it into a clipped "Smir / Walle" beside the chip.
 */
async function expectBrandNeverWrapsOrCollides(page: Page) {
  const brand = await page.evaluate(() => {
    const mark = document.querySelector('header .smirk-brand-mark') as HTMLElement | null;
    const label = document.querySelector('header .smirk-brand-label') as HTMLElement | null;
    const icon = mark?.querySelector('img') as HTMLElement | null;
    const chip = document.querySelector('header [aria-label="Switch identity"]') as HTMLElement | null;
    if (!mark || !label) return null;
    const shown = getComputedStyle(label).display !== 'none';
    const lineHeight = parseFloat(getComputedStyle(label).lineHeight) || parseFloat(getComputedStyle(label).fontSize) * 1.4;
    const lb = label.getBoundingClientRect();
    const mb = mark.getBoundingClientRect();
    const cb = chip?.getBoundingClientRect() ?? null;
    return {
      shown,
      oneLine: lb.height <= lineHeight * 1.5,
      clipped: label.scrollWidth > label.clientWidth + 1 && getComputedStyle(label).textOverflow !== 'ellipsis',
      iconVisible: !!icon && icon.getBoundingClientRect().width > 0,
      brandRight: mb.right,
      chipLeft: cb ? cb.left : null,
    };
  });
  expect(brand, 'the header renders a brand mark').not.toBeNull();
  if (brand!.shown) {
    expect(brand!.oneLine, 'a shown wordmark never wraps').toBe(true);
    expect(brand!.clipped, 'a shown wordmark is never clipped mid-word without an ellipsis').toBe(false);
  } else {
    expect(brand!.iconVisible, 'with the wordmark hidden, the logo still names the app').toBe(true);
  }
  if (brand!.chipLeft !== null) {
    expect(brand!.brandRight, 'the brand ends before the identity chip').toBeLessThanOrEqual(brand!.chipLeft + 0.5);
  }
}

async function expectCompactLayoutWithClickableHeader(page: Page) {
  await expect(page.getByTestId('app-shell-root')).toHaveAttribute('data-layout', 'popup');
  await expect(page.locator('header')).toHaveCount(1);
  await expect(page.locator('aside')).toHaveCount(0);
  // The visible width is the WINDOW the test opened (the popup), never the
  // page's own innerWidth: resistFingerprinting reports a rounded-up viewport.
  const viewport = { w: page.viewportSize()!.width };
  const bodyWidth = await page.evaluate(() => document.body.getBoundingClientRect().width);
  expect(bodyWidth, 'the popup body is no wider than the popup').toBeLessThanOrEqual(viewport.w + 0.5);
  const lastTab = page.getByRole('button', { name: /settings/i }).last();
  if (await lastTab.count()) {
    const tabBox = await lastTab.boundingBox();
    expect(tabBox!.x + tabBox!.width, 'the last bottom tab ends on screen').toBeLessThanOrEqual(viewport.w + 0.5);
  }
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
  await expectBrandNeverWrapsOrCollides(page);
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

// The popup cases render exactly what the extension's action popup renders:
// layout=popup with data-surface="popup", and a Firefox-style outerWidth.
for (const s of SCALES) {
  test(`popup 380x600 at ${s.name}: compact layout, header clickable`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 380, height: 600 }, deviceScaleFactor: s.scale });
    const page = await context.newPage();
    await open(page, { firefoxOuterWidth: s.outer, layout: 'popup' });
    await shot(page, `default-380x600@${s.scale}`);
    await expectCompactLayoutWithClickableHeader(page);
    await context.close();
  });
}

for (const theme of THEMES) {
  test(`popup 380x600, theme ${theme}: compact layout, header clickable, theme applied`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 380, height: 600 } });
    const page = await context.newPage();
    await open(page, { firefoxOuterWidth: 1440, theme, layout: 'popup' });
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

// Release v0.3.1 cross-browser check (area H): in the default theme and in
// Windows XP, at every scale, a real click on EACH header control reaches it.
// The cases above prove hit-testing; this proves each handler actually fires.
const SHELL_CLICKS: Record<string, string> = {
  'Switch identity': 'identity',
  'Open in a browser tab': 'tab',
  'Open in its own window': 'popout',
  'Lock wallet': 'lock',
};
for (const theme of ['default', 'winxp']) {
  for (const s of SCALES) {
    test(`popup 380x600, theme ${theme} at ${s.name}: every header control takes a real click`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 380, height: 600 }, deviceScaleFactor: s.scale });
      const page = await context.newPage();
      await open(page, { firefoxOuterWidth: s.outer, theme, layout: 'popup' });
      await expect(page.getByTestId('app-shell-root')).toHaveAttribute('data-layout', 'popup');
      const expected: string[] = [];
      for (const label of HEADER_CONTROLS) {
        // A trial click fails if anything would intercept it; then click for real.
        const button = page.getByRole('button', { name: label, exact: true });
        await button.click({ trial: true });
        await button.click();
        expected.push(SHELL_CLICKS[label]!);
      }
      expect(await page.evaluate(() => window.__shellClicks)).toEqual(expected);
      await context.close();
    });
  }
}

test('auto layout (no popup context) at 380x600 with Firefox outerWidth is compact', async ({ browser }) => {
  // The measured fallback for surfaces that do not declare themselves. It
  // reads the page's own size, which resistFingerprinting deliberately rounds,
  // so it is not meaningful there; the extension's popup never uses it.
  test.skip(test.info().project.name === 'firefox-rfp', 'resistFingerprinting spoofs the measured viewport by design');
  const context = await browser.newContext({ viewport: { width: 380, height: 600 } });
  const page = await context.newPage();
  await open(page, { firefoxOuterWidth: 1440 });
  await expectCompactLayoutWithClickableHeader(page);
  await context.close();
});

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

test('the popup body is exactly 380x600 whatever the viewport claims', async ({ browser }) => {
  for (const viewport of [{ width: 380, height: 600 }, { width: 800, height: 600 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await open(page, { firefoxOuterWidth: 1440, layout: 'popup' });
    const size = await page.evaluate(() => {
      const r = document.body.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    expect(size, `popup body in a ${viewport.width}px viewport`).toEqual({ w: 380, h: 600 });
    await context.close();
  }
});

test('at popup width the wordmark gives way to the logo, which stays visible', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 380, height: 600 } });
  const page = await context.newPage();
  await open(page, { firefoxOuterWidth: 1440, layout: 'popup' });
  const state = await page.evaluate(() => ({
    label: getComputedStyle(document.querySelector('header .smirk-brand-label')!).display,
    icon: (document.querySelector('header .smirk-brand-mark img') as HTMLElement).getBoundingClientRect().width,
  }));
  expect(state.label, 'wordmark text hidden beside the identity chip').toBe('none');
  expect(state.icon, 'logo visible').toBeGreaterThan(0);
  await expectCompactLayoutWithClickableHeader(page);
  await context.close();
});

test('a brand without a logo keeps its wordmark on one line, never wrapped', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 380, height: 600 } });
  const page = await context.newPage();
  await open(page, { firefoxOuterWidth: 1440, layout: 'popup', brand: 'text' });
  await expectCompactLayoutWithClickableHeader(page);
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
