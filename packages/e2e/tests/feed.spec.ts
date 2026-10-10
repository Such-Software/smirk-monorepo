import { test, expect } from '../fixtures/extension.js';
import { importAndUnlock } from '../fixtures/onboard.js';
import { getCapabilities } from '../fixtures/capabilities.js';
import { isLocalPublishRelay, publishRelaySkipReason } from '../fixtures/relay-guard.js';
import { closeNostrReader, feedAuthorLabel, feedExpectation } from '../fixtures/D-messaging-federation-nostr.js';
import type { FeedCapabilityLike } from '@smirk/core';

/**
 * Feed tab. The operator-curated Nostr feed, which is capability-gated: the tab
 * appears ONLY when the backend advertises `features.feed`. This locks that
 * gating (a feed-less backend must NOT show the tab) and, when a feed IS
 * advertised, that the Feed screen renders exactly the notes the client rules
 * select from the relay (owner notes, premium notes when `show_premium`), with
 * the owner's NIP-51 mute list applied, and that posting rights are coherent.
 *
 * Returning-user spec: SMOKE_ALICE_MNEMONIC. Read-only: it never publishes.
 * It runs against a local relay, or against the production relay through the
 * live lane (`E2E_LIVE=1`), since reading a public feed writes nothing.
 */
const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC?.trim();

test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

test.afterAll(() => closeNostrReader());

test('Feed tab is present + renders iff the backend advertises a feed', async ({
  context,
  extensionId,
}) => {
  const caps = (await getCapabilities()) as unknown as {
    features?: { feed?: boolean };
    messaging?: { relay_url?: string };
    feed?: FeedCapabilityLike | null;
  };
  // A local relay always; the production relay only through the live lane.
  // Verified on prod 2026-08-24: the relay refuses a public kind-1 outright
  // under `premium-post`, so this spec stays read-only everywhere.
  const relayUrl = caps.messaging?.relay_url;
  test.skip(
    !isLocalPublishRelay(relayUrl) && process.env.E2E_LIVE !== '1',
    publishRelaySkipReason(relayUrl),
  );
  const feedAdvertised = !!caps.features?.feed && !!caps.feed;

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
  await expect(page.getByTestId('feed-note').first().or(page.getByTestId('feed-empty'))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#root')).not.toContainText('Failed to load the feed');

  // The rendered feed is what the client rules select from the relay.
  const expected = await feedExpectation(caps.feed!);
  const notes = page.getByTestId('feed-note');
  if (expected.notes.length === 0) {
    await expect(page.getByTestId('feed-empty')).toBeVisible();
  } else {
    await expect(notes, 'the feed rendered a different set of notes than the relay serves').toHaveCount(
      expected.notes.length,
      { timeout: 30_000 },
    );
    for (const note of expected.notes.slice(0, 10)) {
      await expect(
        notes.filter({ hasText: feedAuthorLabel(note) }).filter({ hasText: note.content.slice(0, 40) }).first(),
      ).toBeVisible();
    }
  }
  // Muted authors and notes never render.
  for (const hidden of expected.hiddenByMutes) {
    await expect(notes.filter({ hasText: feedAuthorLabel(hidden) }).filter({ hasText: hidden.content.slice(0, 40) })).toHaveCount(0);
  }
  if (!expected.muteListPublished) {
    test.info().annotations.push({ type: 'not-exercised', description: 'the feed owner has published no mute list' });
  }

  // Posting rights come from the server: exactly one of composer or notice,
  // and a refusal names premium and offers a way to act when plans exist.
  const composer = page.getByTestId('feed-compose');
  const needsPremium = page.getByTestId('feed-needs-premium');
  await expect(composer.or(needsPremium)).toBeVisible({ timeout: 30_000 });
  expect(
    (await composer.isVisible()) !== (await needsPremium.isVisible()),
    'the feed showed both a composer and the premium notice, or neither',
  ).toBe(true);
  if (await needsPremium.isVisible()) {
    await expect(needsPremium).toContainText(/premium/i);
    if (await page.getByTestId('feed-premium-plans').isVisible().catch(() => false)) {
      await expect(page.getByTestId('premium-buy').or(page.getByTestId('premium-redeem')).first()).toBeVisible();
    }
  }
});
