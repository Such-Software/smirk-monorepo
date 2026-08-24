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

// Carol is the grin-carrying smoke wallet; fall back to alice, which the other
// grin specs use, so this still runs wherever only alice is provisioned.
const MNEMONIC = (
  process.env.SMOKE_CAROL_MNEMONIC ?? process.env.SMOKE_ALICE_MNEMONIC
)?.trim();

test('an onboarded wallet has its GRIN key registered with the backend', async ({
  context,
  extensionId,
}) => {
  test.skip(!MNEMONIC, 'no smoke mnemonic set — source secrets/smoke-mnemonics.env');
  // Registration mines on a pow_required backend, so allow more than the
  // default per-test timeout, though not much: the work itself is quick.
  test.setTimeout(4 * 60_000);
  const caps = await getCapabilities();
  test.skip(!caps.chains.grin?.enabled, 'grin disabled on this backend (/capabilities chains.grin)');

  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  // The canonical-GRIN registration is deferred behind unlock + wasm, so poll
  // rather than sampling once: a bare assertion here would be racing the very
  // effect under test and would flake in both directions.
  const deadline = Date.now() + 90_000;
  let userId: string | null = null;
  let grinKey: unknown = null;

  while (Date.now() < deadline) {
    // `smirk_bootstrap_cache_v1`, NOT the unlocked-session cache: the latter is
    // SessionCachePayload (fingerprint, keys, addresses, expiry) and carries no
    // userId at all, so reading it there returns undefined no matter how
    // healthy the backend is. See popup/bootstrap-cache.ts.
    userId = await page.evaluate(async (key) => {
      const s = await chrome.storage.session.get(key);
      const entry = s[key] as { bootstrap?: { userId?: string } } | undefined;
      return entry?.bootstrap?.userId ?? null;
    }, 'smirk_bootstrap_cache_v1');

    if (userId) {
      const res = await fetch(`${BACKEND_URL}/users/${userId}/keys/grin`);
      if (res.ok) {
        grinKey = await res.json();
        if (grinKey) break;
      }
    }
    await page.waitForTimeout(2_000);
  }

  // A null userId means bootstrap never completed, which is a different failure
  // from "registered but missing its grin key". Say which, or the next person
  // debugging this learns only that a variable was null.
  if (!userId) {
    const errScreen = page.getByTestId('bootstrap-error');
    const bootstrapFailed = (await errScreen.count()) > 0;
    const detail = bootstrapFailed
      ? `bootstrap failed on screen with: ${await errScreen.innerText()}`
      : 'bootstrap produced no userId and showed no error. On a backend with ' +
        'registration.pow_required, an unknown wallet must mine before it can ' +
        'register, so this can simply mean the work did not finish in time.';
    throw new Error(`no userId after 90s. ${detail}`);
  }
  expect(
    grinKey,
    'no GRIN key registered for this user: smirk.cash GRIN sign-in would answer ' +
      '"User not found. Please register with Smirk extension first."',
  ).toBeTruthy();
});
