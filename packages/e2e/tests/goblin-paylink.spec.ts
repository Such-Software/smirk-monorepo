import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import { getCapabilities } from '../fixtures/capabilities.js';

/**
 * goblin-paylink: the "Magick Market buyer wallet" path (P3). Pasting a GoblinPay
 * `goblin:`/`nostr:` checkout URI into the universal paste screen must parse it and
 * pre-fill the Grin Send flow (recipient npub → pubkey, amount from the link),
 * rather than reject it as "not a slatepack".
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();
test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

const NPUB = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6';

test('GoblinPay pay-link pre-fills the Grin Send flow', async ({ context, extensionId }) => {
  const caps = await getCapabilities();
  test.skip(!caps.chains.grin?.enabled, 'grin disabled on this backend (/capabilities chains.grin)');

  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });

  // Inbox → Paste → the universal paste-and-dispatch screen.
  await page.getByTestId('nav-tab-inbox').click();
  await expect(page.getByTestId('inbox-tab')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('inbox-paste-slatepack-btn').click();

  const input = page.getByTestId('paste-dispatch-input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(`goblin:${NPUB}?amount=1.5&memo=coffee`);
  await page.getByTestId('paste-dispatch-submit').click();

  // Routed into the Send flow with the recipient pre-filled from the pay-link
  // (the npub decoded to its x-only pubkey hex).
  const addr = page.getByTestId('send-address-input');
  await expect(addr).toBeVisible({ timeout: 15_000 });
  await expect(addr).toHaveValue(/^[0-9a-f]{64}$/i);

  // …and the amount carried through from the link.
  await page.getByTestId('send-address-continue').click();
  await expect(page.getByTestId('send-amount-input')).toHaveValue('1.5', { timeout: 15_000 });
});
