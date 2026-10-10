/**
 * The fiat headline actually shows money.
 *
 * Added after a real build shipped to a human with the total stuck on the "—"
 * placeholder. The cause was environmental (that build pointed at a backend with
 * FEATURE_PRICES off), but nothing in the suite would ever have noticed: every
 * other spec asserts per-asset balances, and the aggregate fiat total on Home is
 * the first thing a user looks at.
 *
 * "—" is the not-available placeholder and "…" is loading. Both are failures
 * here: the point is that a wallet with funds, against a price-serving backend,
 * shows a number.
 */

import { test, expect, BACKEND_URL } from '../fixtures/extension.js';
import { getCapabilities } from '../fixtures/capabilities.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import { LIVE_ASSETS } from '../fixtures/live-send.js';

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC ?? '';
test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('Home shows a fiat total, not the placeholder', async ({
  context,
  extensionId,
  footage,
}) => {
  const caps = await getCapabilities();
  test.skip(
    !caps.features?.prices,
    'backend has FEATURE_PRICES off, so there is no fiat to show',
  );

  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC });
  footage.mark('wallet-ready', 'unlocked wallet, before the flow under test');

  const total = page.getByTestId('home-total-balance');
  await expect(total).toBeVisible({ timeout: 40_000 });

  // Prices arrive after balances, so poll rather than sampling once.
  await expect
    .poll(async () => (await total.textContent())?.trim() ?? '', {
      timeout: 45_000,
      message:
        'fiat total never resolved. Either the price feed is not reaching the ' +
        'wallet, or the backend is not serving /prices.',
    })
    .not.toMatch(/^[—…-]?$/);

  const shown = (await total.textContent())?.trim() ?? '';

  // Must be a real amount. A currency symbol alone, or a lone zero, means the
  // aggregation ran but produced nothing useful.
  expect(shown, `fiat total rendered as "${shown}"`).toMatch(/\d/);
  expect(shown).not.toBe('—');
  expect(shown).not.toBe('…');

  footage.mark('fiat-total-shown', `Home fiat total: ${shown}`);
  console.log(`[fiat] Home total renders as: ${shown}`);
});

/**
 * Every priced coin's own screen shows its USD value under the balance (v0.3.1
 * added it for every priced asset, WOW included), and the freshness cue never
 * leaves "fresh" or "updating" while we look. A coin without a quote on this
 * backend, or with nothing in it, shows no USD line rather than "$0.00".
 */
test('each priced coin screen shows its USD value, and the freshness cue stays fresh', async ({
  context,
  extensionId,
}) => {
  const caps = await getCapabilities();
  test.skip(!caps.features?.prices, 'backend has FEATURE_PRICES off, so there is no fiat to show');
  const res = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/prices`);
  const quotes = res.ok ? ((await res.json()) as { prices?: Record<string, number> }).prices ?? {} : {};
  const priced = new Set(Object.entries(quotes).filter(([, v]) => v > 0).map(([k]) => k.toLowerCase()));

  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC });
  const cue = page.getByTestId('balance-freshness-cue');
  const fresh = async () => {
    if (await cue.count()) {
      expect(['fresh', 'updating'], 'freshness cue').toContain((await cue.first().getAttribute('data-freshness')) ?? 'fresh');
    }
  };

  let checked = 0;
  for (const asset of LIVE_ASSETS.filter((a) => caps.chains[a]?.enabled !== false)) {
    await page.getByTestId('nav-tab-home').click();
    if (!(await page.getByTestId('home-total-balance').isVisible().catch(() => false))) {
      await page.getByTestId('nav-tab-home').click();
    }
    await fresh();
    await page.getByTestId(`asset-row-${asset}`).click();
    const balance = page.getByTestId('asset-detail-balance');
    await expect(balance).toBeVisible({ timeout: 30_000 });
    const amount = /^([\d.]+)/.exec((await balance.innerText()).trim())?.[1] ?? '0';
    const header = balance.locator('xpath=..');
    if (!priced.has(asset)) {
      await expect(header, `${asset} has no quote, so no USD line`).not.toContainText('$');
    } else if (Number(amount) > 0) {
      await expect(header, `${asset} header shows its USD value`).toContainText(/≈ \$[\d,]+\.\d{2} USD|Less than \$0\.01 USD/, { timeout: 30_000 });
      checked += 1;
    }
    await fresh();
  }
  expect(checked, 'at least one funded, priced coin was checked').toBeGreaterThan(0);
});
