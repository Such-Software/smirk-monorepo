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

import { test, expect } from '../fixtures/extension.js';
import { getCapabilities } from '../fixtures/capabilities.js';
import { importAndUnlock } from '../fixtures/onboard.js';

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
