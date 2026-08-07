/**
 * Marketing screenshots: capture the REAL wallet, at store resolution.
 *
 * Store listings are the first thing anyone sees, and mocked-up wallet UI ages
 * badly and lies. These drive the actual extension against a real backend with a
 * funded wallet, so what ships in the listing is what the product does. The
 * balances are genuine (small test funds on the smoke wallet), which is a
 * deliberate choice: nothing here is fabricated.
 *
 * Raw output only. This writes unadorned PNGs; `scripts/make-store-shots.mjs`
 * composites them into the per-store canvases with headlines. Keeping capture
 * and composition separate means re-wording a caption never means re-driving the
 * browser, and the raw frames stay reusable for docs and the site.
 *
 * Captured at deviceScaleFactor 2 so a 500x900 popup yields 1000x1800 — enough
 * to downscale cleanly into every target (Chrome 1280x800, AMO, iOS 6.7"
 * 1290x2796, Play 1080x1920) without upscaling artifacts.
 *
 *   MARKETING_SHOTS=1 npx playwright test tests/marketing-shots.spec.ts
 *
 * Gated so it never runs in the normal suite: it is slow, it needs a funded
 * wallet, and its output is a deliverable rather than an assertion.
 */

import { test, expect } from '../fixtures/extension.js';
import type { Page } from '@playwright/test';
import { importAndUnlock } from '../fixtures/onboard.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC ?? '';
const ENABLED = process.env.MARKETING_SHOTS === '1';

/** Disposable build output, per the workstation storage contract: raw artifacts
 *  go to ~/Build, and only approved deliverables are promoted to Marketing Media. */
const OUT =
  process.env.MARKETING_OUT ??
  join(process.env.HOME ?? '/tmp', 'Build', 'smirk-marketing', 'raw');

test.skip(!ENABLED, 'marketing capture: set MARKETING_SHOTS=1 (produces deliverables, not assertions)');
test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test.setTimeout(10 * 60_000);

/** Let balances/prices settle so no shot catches a skeleton or a spinner. */
async function settle(page: Page, ms = 1200) {
  await page.waitForTimeout(ms);
  // Never ship a frame with a spinner in it. Prices refresh after balances, so
  // an early screenshot catches "Updating…" under the fiat total.
  await page
    .locator('#root')
    .filter({ hasText: /Updating…|Loading/ })
    .waitFor({ state: 'detached', timeout: 8_000 })
    .catch(() => {});
  await page.waitForTimeout(400);
}

async function shot(page: Page, name: string) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

test('capture the wallet surfaces used in store listings', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC });

  // HOME: the money shot. Multi-asset balances plus the fiat total is the single
  // clearest statement of what this is.
  await settle(page, 4000);
  await expect(page.getByTestId('home-total-balance')).toBeVisible({ timeout: 40_000 });
  await shot(page, '01-home-balances');

  // RECEIVE: per-payment addresses are a headline feature, so show the address
  // surface rather than describing it.
  await page.getByTestId('home-action-receive').click();
  await page.getByTestId('receive-asset-xmr').click();
  await expect(page.getByTestId('receive-address')).toBeVisible({ timeout: 30_000 });
  await settle(page);
  await shot(page, '02-receive-xmr');

  // SEND: stop at the address step. Never compose or submit in a capture run.
  await page.getByTestId('nav-tab-home').click();
  await page.getByTestId('home-action-send').click();
  await page.getByTestId('send-asset-btc').click();
  await settle(page);
  await shot(page, '03-send-btc');

  // SWAP: cross-asset without an account anywhere.
  await page.getByTestId('nav-tab-home').click();
  await page.getByTestId('nav-tab-swap').click();
  await settle(page);
  await shot(page, '04-swap');

  // INBOX: tips + encrypted messages.
  await page.getByTestId('nav-tab-inbox').click();
  await settle(page);
  await shot(page, '05-inbox');

  // IDENTITY: the nostr handle. This is the differentiator against every other
  // multi-coin wallet, so it earns its own frame.
  await page.getByTestId('nav-tab-settings').click();
  const nostrNav = page.getByTestId('settings-nostr-nav');
  if (await nostrNav.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await nostrNav.click();
    await expect(page.getByTestId('settings-nostr-screen')).toBeVisible({ timeout: 20_000 });
    await settle(page);
    await shot(page, '06-nostr-identity');
    await page.getByTestId('nav-tab-settings').click();
  }

  // BACKEND PICKER: "run your own" is a claim people do not believe until they
  // see the screen where you type your own URL.
  const backendNav = page.getByTestId('settings-backend-nav');
  if (await backendNav.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await backendNav.click();
    await expect(page.getByTestId('backend-picker')).toBeVisible({ timeout: 20_000 });
    await settle(page);
    await shot(page, '07-self-host-backend');
  }

  // SETTINGS: the surface that shows this is a real wallet, not a demo.
  await page.getByTestId('nav-tab-settings').click();
  await settle(page);
  await shot(page, '08-settings');
});
