import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';

/**
 * Dapp payment popup e2e — the exact flow the "Cannot convert 9.0000 to a BigInt" bug
 * slipped through (there was NO test that drove the payment approval popup).
 *
 * A dummy shop calls `window.smirk.requestPayment` with a HUMAN decimal amount ("9"
 * WOW, the way a website operator quotes it). The wallet must open the approval popup
 * showing "9 WOW" (converted to atomic under the hood), never mislabel it "atomic
 * units", and never crash on the decimal. We seed the origin's asset grant so this test
 * targets the PAYMENT popup directly (the connect approval is a separate flow).
 *
 * Doubles as a mobile-portrait demo capture with `CAPTURE_VIDEO=1` (see fixtures).
 *
 * Requires the local backend + seeds:
 *   set -a && . <monorepo>/packages/smoke-tests/secrets/smoke-mnemonics.env && set +a
 */

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();
test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

const SHOP_ORIGIN = 'http://smirk-dummy-shop.test';
const WOW_ADDRESS =
  'WW454V3kHSKTQtxBpR12MLK8XTd2wHFxkeeW7X5XdnaFZvvmPNVTk357SL8rpfm5Wj1htTn9PVb48csdzpK8mf5233oDBszub';

const SHOP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Wownerogue checkout</title></head>
<body style="font-family:sans-serif;padding:24px;max-width:420px">
  <h1>Wownerogue — pay to play</h1>
  <button id="pay" style="padding:12px 18px;font-size:16px">Pay 9 WOW</button>
  <pre id="out"></pre>
  <script>
    document.getElementById('pay').addEventListener('click', async () => {
      try {
        const r = await window.smirk.requestPayment({ asset: 'wow', amount: '9', address: ${JSON.stringify(WOW_ADDRESS)} });
        document.getElementById('out').textContent = 'ok:' + JSON.stringify(r);
      } catch (e) {
        document.getElementById('out').textContent = 'err:' + (e && e.message);
      }
    });
  </script>
</body></html>`;

test('dapp payment popup shows the human amount (decimal->atomic, no BigInt crash)', async ({
  context,
  extensionId,
}) => {
  // 1. Unlock the wallet (popup surface) so the approval window has a keystore.
  const popup = await context.newPage();
  await importAndUnlock(popup, { extensionId, mnemonic: MNEMONIC! });
  await expect(popup.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  // 2. Seed the origin's WOW grant via the SW so requestPayment reaches the payment
  //    popup directly (connect approval is a separate flow, covered elsewhere).
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await sw.evaluate(
    async ({ key, perm }) => {
      await chrome.storage.local.set({ [key]: perm });
    },
    {
      key: `smirk:dapp:origin:${SHOP_ORIGIN}`,
      perm: { origin: SHOP_ORIGIN, assets: ['wow'] },
    },
  );

  // 3. Serve the dummy shop on a real http origin (content scripts inject window.smirk
  //    only on http(s) pages, never about:blank/data:).
  const shop = await context.newPage();
  await shop.route(`${SHOP_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: SHOP_HTML }),
  );
  await shop.goto(`${SHOP_ORIGIN}/`);
  await shop.waitForFunction(
    () => typeof (window as unknown as { smirk?: { requestPayment?: unknown } }).smirk?.requestPayment === 'function',
    null,
    { timeout: 20_000 },
  );

  // 4. Click Pay -> the approval popup window (chrome.windows.create #approval/<id>) opens.
  const approvalPromise = context.waitForEvent('page', (p) => p.url().includes('#approval'));
  await shop.getByRole('button', { name: 'Pay 9 WOW' }).click();
  const approval = await approvalPromise;

  // 5. The approval window opens; on a fresh session it shows the lock screen first.
  //    Wait for EITHER the lock screen or the approval body, then unlock if locked.
  const pw = approval.getByTestId('lockscreen-password-input');
  await Promise.race([
    pw.waitFor({ timeout: 20_000 }).catch(() => {}),
    approval
      .getByRole('button', { name: 'Deny' })
      .waitFor({ timeout: 20_000 })
      .catch(() => {}),
  ]);
  if (await pw.count()) {
    await pw.fill('e2e-test-password-123');
    await approval.getByRole('button', { name: 'Unlock' }).click();
  }

  // 6. The confirmation shows the HUMAN amount, converted — never "9.0000 (atomic units)"
  //    and never the BigInt crash.
  await expect(approval.locator('body')).toContainText('9 WOW', { timeout: 20_000 });
  await expect(approval.locator('body')).not.toContainText('atomic units');
  await expect(approval.locator('body')).not.toContainText('Cannot convert');

  // 7. Deny (a real WOW broadcast needs funds/node — out of scope for this popup test).
  await approval.getByRole('button', { name: 'Deny' }).click();
});
