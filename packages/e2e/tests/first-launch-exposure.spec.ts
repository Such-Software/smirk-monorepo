/**
 * First-launch network exposure.
 *
 * Methodology mirrors the public "Wallet Privacy Scorecard", which ranks wallets
 * by how many distinct IPs / domains / packets they contact on a cold first
 * launch. Cake and Stack score 100/100 with 0 IPs, 0 domains, 0 packets; the
 * bottom of that chart contacts 41 IPs across 26 domains before the user has
 * done anything.
 *
 * The principle being tested: a wallet must not talk to ANY network endpoint
 * before the user has asked it to do something. Opening the popup is not
 * consent. Nothing here is about whether an endpoint is ours or trustworthy;
 * an unprompted request to our own backend is still a beacon that says "this
 * person just installed a privacy wallet", and it is observable by their ISP,
 * their employer, and anyone on the path.
 *
 * This spec is a REGRESSION GUARD. If it fails, someone added a network call to
 * a startup path. That is a privacy regression even when the feature is good.
 */

import { test, expect } from '../fixtures/extension.js';
import { settleInstallTab } from '../fixtures/A-onboarding-identity-helpers.js';

/** Requests a cold launch is allowed to make. Empty on purpose: the target is
 *  zero. Adding an entry here is a deliberate, reviewable privacy decision. */
const ALLOWED_ORIGINS: string[] = [];

/** Schemes that never leave the machine, so they are not "exposure". */
const LOCAL_SCHEMES = ['chrome-extension:', 'data:', 'blob:', 'about:', 'chrome:'];

function isLocal(url: string): boolean {
  return LOCAL_SCHEMES.some((s) => url.startsWith(s));
}

test('cold first launch contacts zero network endpoints', async ({ context, extensionId }) => {
  const contacted: { url: string; method: string }[] = [];

  // Capture at the context level so service-worker and background fetches are
  // included, not just document subresources. A wallet that phones home from
  // its service worker is still phoning home.
  context.on('request', (req) => {
    const url = req.url();
    if (!isLocal(url)) contacted.push({ url, method: req.method() });
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // Let the popup settle and any deferred bootstrap fire. A wallet that merely
  // DELAYS its beacon has not fixed anything, so wait long enough to catch it.
  await page.waitForTimeout(5000);

  const offenders = contacted.filter((c) => {
    try {
      return !ALLOWED_ORIGINS.includes(new URL(c.url).origin);
    } catch {
      return true;
    }
  });

  const domains = new Set(
    offenders.map((o) => {
      try {
        return new URL(o.url).hostname;
      } catch {
        return o.url;
      }
    }),
  );

  // Report in the scorecard's own units so the number is directly comparable.
  console.log(
    `[first-launch-exposure] ${domains.size} domains, ${offenders.length} requests\n` +
      [...domains].map((d) => `  - ${d}`).join('\n'),
  );

  expect(
    offenders.map((o) => `${o.method} ${o.url}`),
    'a cold launch must contact nothing before the user acts',
  ).toEqual([]);
});

/**
 * The create hand-off is not consent either. Pressing Create in the popup only
 * opens the tab; the tab lands on the welcome screen and must stay silent until
 * the user acts there. A tab that registers, fetches capabilities or prices on
 * load would announce the install exactly as a startup beacon does.
 */
test('handing Create to a tab contacts nothing before the user acts in the tab', async ({ context, extensionId }) => {
  const contacted: string[] = [];
  context.on('request', (req) => {
    const url = req.url();
    if (!isLocal(url)) contacted.push(`${req.method()} ${url}`);
  });

  // A fresh install opens setup in a tab by itself; that load is covered by the
  // listener above too. Let it land so the page awaited below is the hand-off.
  await settleInstallTab(context);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const existing = new Set(context.pages());
  const [tab] = await Promise.all([
    context.waitForEvent('page', { predicate: (page) => !existing.has(page) }),
    popup.getByTestId('onboarding-create-btn').click(),
  ]);
  await tab.waitForLoadState('domcontentloaded');
  expect(tab.url()).toContain('ctx=tab');
  await expect(tab.getByTestId('onboarding-create-btn')).toBeVisible({ timeout: 30_000 });
  // Same window as the cold-launch check: a delayed beacon is still a beacon.
  await tab.waitForTimeout(5000);

  const offenders = contacted.filter((c) => {
    try {
      return !ALLOWED_ORIGINS.includes(new URL(c.split(' ')[1] ?? '').origin);
    } catch {
      return true;
    }
  });
  expect(offenders, 'the create hand-off contacted the network before the user acted in the tab').toEqual([]);
});
