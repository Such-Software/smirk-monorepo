import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import { getCapabilities } from '../fixtures/capabilities.js';

/**
 * Feed tab. The operator-curated Nostr feed, which is capability-gated: the tab
 * appears ONLY when the backend advertises `features.feed`. This locks that
 * gating (a feed-less backend must NOT show the tab) and, when a feed IS
 * advertised, that the Feed screen renders without erroring.
 *
 * Returning-user spec: local backend + SMOKE_ALICE_MNEMONIC. Read-only (no writes).
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test('Feed tab is present + renders iff the backend advertises a feed', async ({
  context,
  extensionId,
}) => {
  const caps = (await getCapabilities()) as unknown as { features?: { feed?: boolean } };
  const feedAdvertised = !!caps.features?.feed;

  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC! });
  await expect(page.getByTestId('bottom-nav')).toBeVisible({ timeout: 40_000 });

  const feedTab = page.getByTestId('nav-tab-feed');
  if (!feedAdvertised) {
    // Opt-in gating: no feed capability → the tab must be absent.
    await expect(feedTab).toHaveCount(0);
    return;
  }

  // Feed advertised → tab is shown and the screen renders (notes or empty state),
  // not an error.
  await expect(feedTab).toBeVisible({ timeout: 40_000 });
  await feedTab.click();
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#root')).not.toContainText('Failed to load the feed');
});
