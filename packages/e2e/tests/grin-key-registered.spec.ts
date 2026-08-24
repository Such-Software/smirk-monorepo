/**
 * grin-key-registered: signing in to smirk.cash with GRIN needs a registered
 * GRIN key, and the wallet registers it on a deferred path that can be missed.
 *
 * Reported from real use on 2026-08-23: choosing GRIN on the smirk.cash sign-in
 * page returned "User not found. Please register with Smirk extension first."
 * for a wallet that had completed onboarding.
 *
 * Why that happens is specific. Website sign-in does NOT create anything: it
 * hashes the signed asset's public key and resolves an already-registered wallet
 * through `get_user_by_pubkey_hash` (smirk-backend-core `api/website.rs`). So an
 * unregistered GRIN key is indistinguishable from an unknown user, and the page
 * says so. Meanwhile the wallet registers its canonical GRIN slatepack address
 * in a deferred effect (`popup/index.tsx`) that only runs once the wallet is
 * unlocked AND wasm is up. Miss that window and the account exists while GRIN
 * sign-in cannot resolve it.
 *
 * This asserts the postcondition users actually depend on: once a wallet is
 * onboarded and settled, the backend holds a GRIN key for it. It is deliberately
 * an assertion about the BACKEND's state, not about the wallet's UI, because the
 * backend is what the sign-in page consults.
 */
import { test, expect } from '../fixtures/extension.js';
import { BACKEND_URL } from '../fixtures/extension.js';
import { getCapabilities } from '../fixtures/capabilities.js';
import { importAndUnlock } from '../fixtures/onboard.js';

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

test('an onboarded wallet has its GRIN key registered with the backend', async ({
  context,
  extensionId,
}) => {
  test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set');
  const caps = await getCapabilities();
  test.skip(!caps.chains.grin?.enabled, 'grin disabled on this backend (/capabilities chains.grin)');

  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  // The canonical-GRIN registration is deferred behind unlock + wasm, so poll
  // rather than sampling once: a bare assertion here would be racing the very
  // effect under test and would flake in both directions.
  const deadline = Date.now() + 60_000;
  let userId: string | null = null;
  let grinKey: unknown = null;

  while (Date.now() < deadline) {
    userId = await page.evaluate(async (key) => {
      const s = await chrome.storage.session.get(key);
      const cache = s[key] as { bootstrap?: { userId?: string } } | undefined;
      return cache?.bootstrap?.userId ?? null;
    }, 'smirk_unlocked_session_cache');

    if (userId) {
      const res = await fetch(`${BACKEND_URL}/users/${userId}/keys/grin`);
      if (res.ok) {
        grinKey = await res.json();
        if (grinKey) break;
      }
    }
    await page.waitForTimeout(2_000);
  }

  expect(userId, 'bootstrap never produced a userId; sign-in cannot work at all').toBeTruthy();
  expect(
    grinKey,
    'no GRIN key registered for this user: smirk.cash GRIN sign-in would answer ' +
      '"User not found. Please register with Smirk extension first."',
  ).toBeTruthy();
});
