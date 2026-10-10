import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import { getCapabilities } from '../fixtures/capabilities.js';
import { BroadcastMonitor } from '../fixtures/live-send.js';

/**
 * grin-send-nostr: the send-side of the Nostr/Goblin grin path (P3 + federation).
 *
 * Proves through the REAL send wizard that a Grin recipient can be a Nostr npub or a
 * NIP-05 name (federation), which routes the send over the gift-wrap channel instead
 * of a slatepack address. We assert RECIPIENT ACCEPTANCE + advance to the amount
 * step; actual gift-wrap delivery needs a relay + funded counterparty and is a
 * two-wallet integration scenario (covered by @smirk/core unit tests +
 * manual §3 in the test guide).
 *
 * The validator logic itself (npub / NIP-05 accepted, garbage rejected) is unit-
 * tested in packages/extension address.test.ts; here we prove the WIRING into the UI.
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();
test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

// A real, valid npub: used only for recipient-acceptance (no resolution/delivery).
const NPUB = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6';

test('Grin send accepts an npub + a NIP-05 name as recipient (federation)', async ({
  context,
  extensionId,
}) => {
  const caps = await getCapabilities();
  test.skip(!caps.chains.grin?.enabled, 'grin disabled on this backend (/capabilities chains.grin)');

  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });

  // Home → Send → pick Grin.
  await page.getByTestId('home-action-send').click();
  const grinPick = page.getByTestId('send-asset-grin');
  await expect(grinPick).toBeVisible({ timeout: 15_000 });
  await grinPick.click();

  const addr = page.getByTestId('send-address-input');
  const cont = page.getByTestId('send-address-continue');
  await expect(addr).toBeVisible();

  // 1. An npub is a valid Grin recipient → Continue enables (routes over gift-wrap).
  await addr.fill(NPUB);
  await expect(cont).toBeEnabled({ timeout: 10_000 });

  // 2. A NIP-05 name is accepted by format (resolved at send time) → enables.
  await addr.fill('alice@smirk.cash');
  await expect(cont).toBeEnabled({ timeout: 10_000 });

  // 3. Advancing with the npub reaches the amount step: recipient accepted end-to-end.
  await addr.fill(NPUB);
  await expect(cont).toBeEnabled();
  await cont.click();
  await expect(page.getByTestId('send-amount-input')).toBeVisible({ timeout: 15_000 });
});

/**
 * From the Grin coin screen: Send opens at destination entry, an npub with a
 * broken checksum is refused, and a good npub reaches Compose, whose next step
 * is the slatepack. Nothing past Compose is tapped, so no slate is built,
 * nothing is delivered over Nostr and nothing is broadcast (the broadcast
 * endpoints are blocked and must see no attempt).
 */
test('Grin Send from the coin screen refuses a malformed npub and stops at Compose for a good one', async ({
  context,
  extensionId,
}) => {
  const caps = await getCapabilities();
  test.skip(!caps.chains.grin?.enabled, 'grin disabled on this backend (/capabilities chains.grin)');
  const trip = await BroadcastMonitor.attach(context, 'block');
  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });

  await page.getByTestId('asset-row-grin').click();
  await expect(page.getByTestId('asset-detail-balance')).toBeVisible({ timeout: 30_000 });
  await page.locator('button', { hasText: /^↗\s*Send$/ }).click();
  const addr = page.getByTestId('send-address-input');
  await expect(addr).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid^="send-asset-"]')).toHaveCount(0);

  // Same length and alphabet as a real npub; the bech32 checksum fails.
  await addr.fill(`npub1${'q'.repeat(58)}`);
  await page.getByTestId('send-address-continue').click();
  await expect(page.locator('#root')).toContainText('Not a valid npub');
  await expect(page.getByTestId('send-amount-input')).toHaveCount(0);

  await addr.fill(NPUB);
  await page.getByTestId('send-address-continue').click();
  await page.getByTestId('send-amount-input').fill('0.01');
  await expect(page.getByTestId('send-compose-continue')).toHaveText('Continue to slatepack');
  await expect(page.locator('#root')).not.toContainText('Share slatepack');
  expect(trip.count(), 'nothing was broadcast').toBe(0);
});
