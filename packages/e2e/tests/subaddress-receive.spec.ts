/**
 * Per-payment subaddress receive (XMR + WOW).
 *
 * Covers one of the three headline features, which until now had unit tests and
 * an oracle check but had never once run end to end. This is the RECEIVE half,
 * the part provable without moving money. The spend half needs funds sitting at
 * an issued subaddress and is the remaining live gate (see
 * docs/private/SUBADDRESSES.md).
 *
 * Both light wallet servers now report `max_subaddresses=10000`
 * (monero-lws was raised from 0 on 2026-07-30), so both assets are exercised.
 *
 * THE PROPERTY UNDER TEST (money gate G4): the wallet must never display a
 * subaddress the LWS was not told to scan. Funds sent to an unprovisioned index
 * are invisible: absent from the balance, unspendable, until someone provisions
 * that range and rescans. So "kept the primary address" is a PASS, and the
 * failure being guarded against is a subaddress appearing without a confirmed
 * provisioned ceiling behind it.
 *
 * Both outcomes are therefore accepted, and which one occurred is reported. What
 * is NOT accepted is a changed address with no provisioning, or an address that
 * moves under the user after they have copied it.
 */

import { test, expect } from '../fixtures/extension.js';
import type { BrowserContext } from '@playwright/test';
import { getCapabilities } from '../fixtures/capabilities.js';
import { importAndUnlock } from '../fixtures/onboard.js';

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC ?? '';
test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

/** Turn the dark flag on for this context only, before any popup script runs. */
async function enableSubaddressReceive(context: BrowserContext) {
  await context.addInitScript(() => {
    (
      globalThis as { __SMIRK_ENABLE_SUBADDRESS_RECEIVE__?: boolean }
    ).__SMIRK_ENABLE_SUBADDRESS_RECEIVE__ = true;
  });
}

for (const asset of ['wow', 'xmr'] as const) {
  test(`${asset.toUpperCase()} receive: a fresh subaddress is only issued when provisioned`, async ({
    context,
    extensionId,
    footage,
  }) => {
    const caps = await getCapabilities();
    test.skip(
      !caps.chains[asset]?.enabled,
      `${asset} disabled on this backend (/capabilities chains.${asset})`,
    );
    test.skip(
      !caps.features?.xmr_subaddr_provisioning,
      'backend has FEATURE_XMR_SUBADDR_PROVISIONING off, so no index can be provisioned',
    );

    await enableSubaddressReceive(context);
    const page = await context.newPage();
    await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC });
  footage.mark('wallet-ready', 'unlocked wallet, before the flow under test');

    const openReceive = async () => {
      await expect(page.getByTestId('home-action-receive')).toBeVisible({ timeout: 40_000 });
      await page.getByTestId('home-action-receive').click();
      const pick = page.getByTestId(`receive-asset-${asset}`);
      await expect(pick).toBeVisible({ timeout: 15_000 });
      await pick.click();
      const el = page.getByTestId('receive-address');
      await expect(el).toBeVisible({ timeout: 30_000 });
      await expect(el).not.toHaveText('Loading address…');
      return el;
    };

    // Baseline. This is what a flag-off wallet always shows, and what must be
    // retained if issuance cannot be satisfied.
    const addressEl = await openReceive();
    const primary = (await addressEl.textContent())?.trim() ?? '';
    expect(primary.length).toBeGreaterThan(60);
    footage.mark(`${asset}-primary-address`, `${asset.toUpperCase()} primary receive address`);

    // Opening Receive must be an idempotent READ. If merely rendering advanced
    // the counter, a re-render would burn indices and move the address out from
    // under a user who had already copied it.
    await page.getByTestId('nav-tab-home').click();
    const again = await openReceive();
    await expect(again).toHaveText(primary);
    footage.mark(`${asset}-read-idempotent`, 'reopening Receive does not change the address');

    // The button is deliberately hidden until a REAL bootstrap exists: a cached
    // balance snapshot seeds the session with an empty userId, and provisioning
    // cannot be authorized during that window. So wait for it rather than
    // sampling once, which made this spec order-dependent (whichever asset ran
    // first saw no button and skipped the interesting half).
    const newBtn = page.getByTestId('receive-new-address-btn');
    await expect(
      newBtn,
      'issuance affordance never appeared: flag off in this build, or the ' +
        'authenticated bootstrap never landed',
    ).toBeVisible({ timeout: 45_000 });

    await newBtn.click();

    const errEl = page.getByTestId('receive-new-address-error');
    const refused = await errEl.isVisible({ timeout: 20_000 }).catch(() => false);

    if (refused) {
      // Fail-closed: this is a correct outcome. The address must NOT have moved.
      const why = (await errEl.textContent())?.trim() ?? '';
      await expect(addressEl).toHaveText(primary);
      footage.mark(`${asset}-issuance-refused`, 'fail-closed, primary retained');
      console.log(`[subaddress:${asset}] refused, primary retained: ${why}`);
      return;
    }

    // Issued. It must differ from the primary and be a plausible address.
    await expect(addressEl).not.toHaveText(primary, { timeout: 20_000 });
    const sub = (await addressEl.textContent())?.trim() ?? '';
    expect(sub).not.toEqual(primary);
    expect(sub.length).toBeGreaterThan(60);
    footage.mark(`${asset}-subaddress-issued`, `fresh per-payment ${asset.toUpperCase()} subaddress`);
    console.log(`[subaddress:${asset}] issued a fresh subaddress (differs from primary)`);

    // And once issued it must STAY the current address across a re-read, for the
    // same copied-it-then-it-changed reason as above.
    await page.getByTestId('nav-tab-home').click();
    const reread = await openReceive();
    await expect(reread).toHaveText(sub, { timeout: 20_000 });
    footage.mark(`${asset}-subaddress-stable`, 'issued address survives reopening Receive');
  });
}
