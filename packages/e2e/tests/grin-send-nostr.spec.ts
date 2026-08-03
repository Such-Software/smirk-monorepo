import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import { getCapabilities } from '../fixtures/capabilities.js';

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
