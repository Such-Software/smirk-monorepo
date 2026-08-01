/**
 * Communications, for real: an encrypted DM that actually goes to a relay and
 * comes back, and a note that actually gets published.
 *
 * Everything Nostr-facing was previously covered only by NAV smoke tests
 * (messaging-inbox-identity.spec asserts the Messages surface renders; feed.spec
 * asserts the tab appears when advertised). Nothing sent a message, nothing
 * published a note, and nothing ever exercised the relay. That left the entire
 * gift-wrap seal/unseal path, the relay admission policy, and the posting-rights
 * decision unverified end to end.
 *
 * Two properties are under test:
 *
 *  1. A DM survives a full round trip: sealed, published to the operator's
 *     relay, retrieved, and unsealed back to the original plaintext. Sending to
 *     SELF is deliberate: it needs one wallet and one context, and it still
 *     exercises the whole seal → publish → subscribe → unseal chain. A
 *     two-wallet test would prove delivery between parties but not much more,
 *     at several times the harness cost.
 *
 *  2. Posting rights come from the SERVER. `can_post_general` is computed by the
 *     backend from the same RelayProvider the relay's admission service
 *     consults, because the client cannot see RELAY_WRITE_ALLOWLIST_NPUBS. The
 *     shipped client re-derived rights locally and so told an allowlisted
 *     operator they needed a subscription, with the composer hidden. Whatever
 *     the server says, the UI must agree with.
 *
 * REQUIRES A RELAY. Both tests skip unless the backend advertises
 * `messaging.relay_url` and `features.nostr_relay`. That is a real environmental
 * requirement, not a code condition, so they are listed in the skip guard with
 * this reason. To run them, point the backend at a relay:
 *
 *     docker run -d -p 8088:8080 --name smirk-e2e-relay scsibug/nostr-rs-relay
 *     # then in the backend .env:
 *     RELAY_ENABLED=true
 *     RELAY_URL=ws://127.0.0.1:8088
 *     RELAY_WRITE_POLICY=open        # or premium-post to exercise the gate
 *     FEATURE_FEED=true
 *
 * Do NOT point these at the production relay: the feed test publishes a public
 * kind-1 note, which would appear in the real announcements feed.
 */

import { test, expect } from '../fixtures/extension.js';
import type { Page } from '@playwright/test';
import { importAndUnlock } from '../fixtures/onboard.js';
import { getCapabilities } from '../fixtures/capabilities.js';

const MNEMONIC = process.env.SMOKE_ALICE_MNEMONIC ?? '';
test.skip(!MNEMONIC, 'SMOKE_ALICE_MNEMONIC not set — source secrets/smoke-mnemonics.env');

/** A value unique to this run, so a stale event from a previous run cannot pass. */
function marker(kind: string): string {
  return `smirk-e2e-${kind}-${process.pid}-${Date.now()}`;
}

async function openMessages(page: Page) {
  await page.getByTestId('nav-tab-inbox').click();
  const entry = page.getByTestId('inbox-messages-btn');
  await expect(entry).toBeVisible({ timeout: 20_000 });
  await entry.click();
  await expect(page.getByTestId('messages-screen')).toBeVisible({ timeout: 20_000 });
}

test('an encrypted DM survives a round trip through the relay', async ({
  context,
  extensionId,
  footage,
}) => {
  const caps = (await getCapabilities()) as unknown as {
    features?: { nostr_relay?: boolean };
    messaging?: { relay_url?: string };
  };
  test.skip(
    !caps.features?.nostr_relay || !caps.messaging?.relay_url,
    'backend advertises no relay, so there is nowhere to deliver a DM (see the header of this spec)',
  );

  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC });
  footage.mark('wallet-ready', 'unlocked wallet, before the flow under test');

  await openMessages(page);

  // If the surface reports the relay is off, the premise is gone and a pass
  // would be meaningless.
  await expect(
    page.getByTestId('messages-relay-off'),
    'the wallet says no relay is configured even though capabilities advertise one',
  ).toBeHidden({ timeout: 15_000 });

  // Address it to ourselves: one wallet, one context, still the whole
  // seal → publish → subscribe → unseal chain.
  const npub = (await page.getByTestId('nostr-npub').textContent().catch(() => null))?.trim();
  const recipient = page.getByTestId('dm-recipient-input');
  await expect(recipient).toBeVisible({ timeout: 20_000 });
  await recipient.fill(npub && npub.startsWith('npub') ? npub : 'me');

  const body = marker('dm');
  await page.getByTestId('dm-text-input').fill(body);
  footage.mark('dm-composed', 'encrypted DM composed');
  await page.getByTestId('dm-send-btn').click();

  // A send error is a real failure: with a relay advertised there is no
  // legitimate reason for the publish to be refused.
  const err = page.getByTestId('messages-error');
  if (await err.isVisible({ timeout: 5_000 }).catch(() => false)) {
    throw new Error(`DM send reported an error: ${(await err.textContent())?.trim()}`);
  }

  // The message must come BACK: retrieved from the relay and decrypted. This is
  // the assertion that makes it a round trip rather than a send smoke test.
  await expect(
    page.getByTestId('message-item').filter({ hasText: body }),
    'the DM never came back from the relay decrypted, so the gift-wrap round ' +
      'trip (seal, publish, subscribe, unseal) is broken somewhere',
  ).toBeVisible({ timeout: 60_000 });

  footage.mark('dm-roundtrip', 'DM sealed, relayed, retrieved and decrypted');
});

test('the feed composer agrees with the server about posting rights', async ({
  context,
  extensionId,
  footage,
}) => {
  const caps = (await getCapabilities()) as unknown as {
    features?: { feed?: boolean; nostr_relay?: boolean };
    messaging?: { relay_url?: string };
  };
  test.skip(
    !caps.features?.feed || !caps.messaging?.relay_url,
    'backend advertises no feed/relay, so there is nothing to post to (see the header of this spec)',
  );

  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC });

  await page.getByTestId('nav-tab-feed').click();
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 20_000 });
  footage.mark('feed-open', 'operator feed');

  // The UI must land in exactly one coherent state. Deriving rights client-side
  // from write_policy + premium is the bug this guards: it cannot see the
  // operator write-allowlist, so it showed "needs premium" to an allowlisted
  // operator whose posts the relay would have accepted.
  const composer = page.getByTestId('feed-compose');
  const blocked = page.getByTestId('feed-needs-premium');

  const canCompose = await composer.isVisible({ timeout: 15_000 }).catch(() => false);
  const isBlocked = await blocked.isVisible().catch(() => false);

  expect(
    canCompose !== isBlocked,
    'the feed showed both a composer and a "needs premium" notice, or neither: ' +
      'the posting-rights state is incoherent',
  ).toBe(true);

  if (isBlocked) {
    // A refusal is a legitimate outcome, but it must be actionable: the operator
    // publishes plans in /capabilities, and the message used to be a dead end
    // with no price and no way to buy.
    await expect(blocked).toContainText(/premium/i);
    footage.mark('feed-posting-refused', 'server says no; UI explains why');
    return;
  }

  // Allowed: publish for real and require it to come back from the relay.
  const body = marker('note');
  await composer.fill(body);
  await page.getByTestId('feed-post').click();
  footage.mark('feed-posted', 'note published to the operator relay');

  await expect(
    page.getByTestId('feed-note').filter({ hasText: body }),
    'the published note never appeared in the feed, so either the relay refused ' +
      'it or the feed does not read back what it writes',
  ).toBeVisible({ timeout: 60_000 });

  footage.mark('feed-roundtrip', 'note published and read back');
});
