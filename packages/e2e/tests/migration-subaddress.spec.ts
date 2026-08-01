/**
 * v0.2.4 -> v0.3 migration lands on a WORKING subaddress wallet.
 *
 * Subaddresses ship in v0.3, so a migrating user must not end up on a
 * second-class wallet that only has the old static address. This is the release
 * path, and until now it had never run: migration has 30 unit tests (including
 * ship-gate KATs against real v0.2.4-encoded blobs) and subaddresses have their
 * own specs, but the COMBINATION was untested.
 *
 * Why it should work in theory, and therefore what this guards:
 *   - seed and identity are seed-derived, so XMR/WOW keys are byte-identical
 *     across the migration and subaddress derivation is unaffected;
 *   - the issued-index counter is keyed by wallet fingerprint, which does not
 *     change, so a migrated wallet keeps its place in the sequence;
 *   - a v0.2.4 LWS account was registered BEFORE provisioning existed, so the
 *     backend has to provision an ALREADY-REGISTERED account. That path was
 *     added late (it used to be a no-op) and is the most likely thing to break.
 *
 * The failure this is really hunting: migration completes, everything looks
 * fine, and then issuance refuses forever because nothing ever provisioned the
 * pre-existing LWS account.
 */

import { test, expect } from '../fixtures/extension.js';
import type { BrowserContext } from '@playwright/test';
import { encryptPrivateKey } from '@smirk/core';
import { getCapabilities } from '../fixtures/capabilities.js';

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC ?? '';
test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

const PASSWORD = 'e2e-test-password-123';
/** chrome.storage.local key the legacy v0.2 wallet persisted under. */
const LEGACY_WALLET_KEY = 'walletState';

async function enableSubaddressReceive(context: BrowserContext) {
  await context.addInitScript(() => {
    (
      globalThis as { __SMIRK_ENABLE_SUBADDRESS_RECEIVE__?: boolean }
    ).__SMIRK_ENABLE_SUBADDRESS_RECEIVE__ = true;
  });
}

test('a migrated v0.2.4 wallet can issue per-payment subaddresses', async ({
  context,
  extensionId,
  footage,
}) => {
  const caps = await getCapabilities();
  test.skip(!caps.chains.wow?.enabled, 'wow disabled on this backend');
  test.skip(
    !caps.features?.xmr_subaddr_provisioning,
    'backend has FEATURE_XMR_SUBADDR_PROVISIONING off',
  );

  await enableSubaddressReceive(context);

  // Seal the mnemonic exactly as v0.2.4 did. The legacy seal is byte-identical
  // XChaCha20-Poly1305 + PBKDF2-SHA256, so using core's own encryptor produces a
  // genuine legacy blob. `pbkdf2Iterations` is written explicitly for the 600k
  // cohort; the 100k cohort is the one where it is ABSENT, covered by unit KATs.
  const { encrypted, salt } = await encryptPrivateKey(
    new TextEncoder().encode(MNEMONIC),
    PASSWORD,
    600_000,
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // Plant the legacy wallet, then reload so detection runs on mount.
  await page.evaluate(
    async ([key, blob]) => {
      await (globalThis as unknown as {
        chrome: { storage: { local: { set: (o: Record<string, unknown>) => Promise<void> } } };
      }).chrome.storage.local.set({ [key as string]: blob });
    },
    [LEGACY_WALLET_KEY, { encryptedSeed: encrypted, seedSalt: salt, pbkdf2Iterations: 600_000 }] as const,
  );
  await page.reload();

  // The gate must offer migration rather than fresh onboarding. If this fails,
  // detection regressed and every v0.2.4 user would be shown "create a wallet",
  // which is the worst possible outcome for someone with funds.
  await expect(
    page.locator('#root'),
    'migration gate did not appear for a planted v0.2.4 wallet',
  ).toContainText(/migrat|upgrade|welcome back/i, { timeout: 30_000 });
  footage.mark('migration-detected', 'v0.2.4 wallet detected, migration offered');

  // The wizard is two steps: an explanation, then the password. Unlock with the
  // LEGACY password; migration reseals into the v0.3 keystore and then converges
  // the idempotent identity-link and BTC/LTC sweep steps.
  await page.getByTestId('migrate-begin-btn').click();
  const pw = page.getByTestId('migrate-password');
  await expect(pw).toBeVisible({ timeout: 20_000 });
  await pw.fill(PASSWORD);
  await page.keyboard.press('Enter');

  // Migration finishes on a done screen that reports the sweep and the new
  // Nostr identity. Assert those, since they are the two things a migrating user
  // is promised, then continue into the wallet.
  const done = page.getByTestId('migrate-done-btn');
  await expect(done, 'migration never reached the done screen').toBeVisible({
    timeout: 90_000,
  });
  await expect(page.locator('#root')).toContainText(/swept/i);
  await expect(page.locator('#root')).toContainText(/npub|Nostr identity/i);
  footage.mark('migration-complete', 'reseal + BTC/LTC sweep + Nostr identity done');
  await done.click();

  // Authenticated Home. Alice's real WOW balance proves the session bootstrapped
  // rather than merely rendering a cached snapshot.
  await expect(page.locator('#root')).toContainText('19.79', { timeout: 60_000 });
  footage.mark('migrated-home', 'migrated wallet on Home with real balances');

  // Now the point of the test: subaddresses on a migrated wallet.
  await expect(page.getByTestId('home-action-receive')).toBeVisible({ timeout: 40_000 });
  await page.getByTestId('home-action-receive').click();
  await page.getByTestId('receive-asset-wow').click();

  const addressEl = page.getByTestId('receive-address');
  await expect(addressEl).toBeVisible({ timeout: 30_000 });
  await expect(addressEl).not.toHaveText('Loading address…');
  const primary = (await addressEl.textContent())?.trim() ?? '';
  expect(primary.length).toBeGreaterThan(60);

  const newBtn = page.getByTestId('receive-new-address-btn');
  await expect(
    newBtn,
    'no issuance affordance on a migrated wallet: either the flag did not reach ' +
      'this build, or the authenticated bootstrap never landed',
  ).toBeVisible({ timeout: 45_000 });

  await newBtn.click();

  // A refusal here is the specific bug this spec exists to catch: it would mean
  // the pre-existing v0.2.4 LWS account never got provisioned, so a migrated
  // user could never receive to a fresh address.
  const errEl = page.getByTestId('receive-new-address-error');
  if (await errEl.isVisible({ timeout: 15_000 }).catch(() => false)) {
    const why = (await errEl.textContent())?.trim() ?? '';
    throw new Error(
      `migrated wallet could not issue a subaddress: ${why}\n` +
        'A v0.2.4 account was registered before provisioning existed, so the ' +
        'backend must provision an already-registered account.',
    );
  }

  await expect(addressEl).not.toHaveText(primary, { timeout: 20_000 });
  const sub = (await addressEl.textContent())?.trim() ?? '';
  expect(sub).not.toEqual(primary);
  expect(sub.length).toBeGreaterThan(60);
  footage.mark('subaddress-on-migrated-wallet', 'migrated v0.2.4 wallet issued a fresh subaddress');
});
