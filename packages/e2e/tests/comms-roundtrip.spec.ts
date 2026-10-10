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
 * Production relay: only through the reviewed live lane. With
 * `E2E_LIVE_RELAY=1` the DM round trip runs against the operator relay (a
 * kind-1059 gift wrap, ciphertext under a throwaway key, nothing public). The
 * feed test then checks the posting-rights state read-only, and publishes its
 * public kind-1 note only when the server grants posting rights AND the owner
 * approved a note for the run (`E2E_LIVE_FEED_POST=1`). See relay-guard.ts.
 */

import { test, expect } from '../fixtures/extension.js';
import type { Page } from '@playwright/test';
import { importAndUnlock } from '../fixtures/onboard.js';
import { deriveNostrIdentity } from '@smirk/core';
import { getCapabilities } from '../fixtures/capabilities.js';
import { liveRelaySkipReason } from '../fixtures/relay-guard.js';
import { closeNostrReader, hasDmInbox, inboxWraps, newInboxWraps } from '../fixtures/D-messaging-federation-nostr.js';

test.afterAll(() => closeNostrReader());

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

// A full wallet import plus a publish/subscribe round trip through a real relay
// does not fit the default 90s budget when this is the first test in a fresh
// context (the import alone can take most of it). The failure looked like a
// missing compose input, which sent me looking at render conditions that were
// fine.
test.setTimeout(180_000);

test('an encrypted DM survives a round trip through the relay', async ({
  context,
  extensionId,
  footage,
}) => {
  const caps = (await getCapabilities()) as unknown as {
    features?: { nostr_relay?: boolean };
    messaging?: { relay_url?: string; inbound_pow_bits?: number };
  };
  test.skip(
    !caps.features?.nostr_relay || !caps.messaging?.relay_url,
    'backend advertises no relay, so there is nowhere to deliver a DM (see the header of this spec)',
  );

  // A LOCAL relay, or the production relay through the explicit live lane,
  // which admits only gift wraps (kind 1059). Enforced, not merely documented.
  const relayRefusal = liveRelaySkipReason(caps.messaging?.relay_url, 1059);
  test.skip(relayRefusal !== null, relayRefusal ?? '');
  const relayUrl = caps.messaging!.relay_url!;

  const page = await context.newPage();
  await importAndUnlock(page, { extensionId, mnemonic: MNEMONIC });
  footage.mark('wallet-ready', 'unlocked wallet, before the flow under test');

  await openMessages(page);

  // Prove the compose surface is actually up. Asserting `messages-relay-off` is
  // HIDDEN was vacuous: toBeHidden() also passes when the element does not exist,
  // so it said nothing while the screen was still loading. Wait for the thing
  // that only exists in the ready branch instead.
  await expect(
    page.getByTestId('dm-recipient-input'),
    'the DM compose surface never came up; if messages-relay-off is showing, the ' +
      'wallet thinks this backend runs no relay',
  ).toBeVisible({ timeout: 60_000 });

  // Address it to ourselves: one wallet, one context, still the whole
  // seal → publish → subscribe → unseal chain.
  //
  // Derived here rather than scraped from the UI. Reading `nostr-npub` looked
  // reasonable but that testid only exists on the IDENTITY screen, and
  // `.textContent()` auto-waits, so on Messages it silently consumed the entire
  // test budget before the `.catch()` could fire. The failure then presented as
  // a timeout somewhere else entirely.
  const self = deriveNostrIdentity(MNEMONIC, 0);
  const npub = self.npub;
  const selfHex = self.pubkeyHex;
  self.privateKey.fill(0);
  await page.getByTestId('dm-recipient-input').fill(npub);

  // What the relay must hold afterwards, and whether the wallet can know where
  // we read (our own kind-10050 inbox list).
  const before = await inboxWraps(relayUrl, selfHex);
  const inbox = await hasDmInbox(relayUrl, selfHex);

  const body = marker('dm');
  await page.getByTestId('dm-text-input').fill(body);
  footage.mark('dm-composed', 'encrypted DM composed');
  await page.getByTestId('dm-send-btn').click();

  // A send error is a real failure: with a relay advertised there is no
  // legitimate reason for the publish to be refused. Success clears the box.
  const err = page.getByTestId('messages-error');
  await expect
    .poll(async () => (await err.isVisible()) || (await page.getByTestId('dm-text-input').inputValue()) === '', {
      timeout: 60_000,
      message: 'the send never resolved',
    })
    .toBe(true);
  if (await err.isVisible()) {
    throw new Error(`DM send reported an error: ${(await err.textContent())?.trim()}`);
  }

  // The reach notice is honest: it shows exactly when no inbox list exists.
  const notice = page.getByTestId('messages-reach-notice');
  if (inbox) await expect(notice, 'the wallet warned about an inbox that exists').toBeHidden();
  else await expect(notice, 'no inbox list exists, so the wallet must say it reached only this relay').toBeVisible();

  // The relay holds the wrap, mined to the difficulty it advertises.
  const fresh = await newInboxWraps(relayUrl, selfHex, before);
  expect(fresh.size, 'the relay holds no new gift wrap after a reported send').toBeGreaterThan(0);
  for (const bits of fresh.values()) {
    expect(bits, 'the gift wrap carries less proof-of-work than the relay advertises').toBeGreaterThanOrEqual(
      caps.messaging?.inbound_pow_bits ?? 0,
    );
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

  // A LOCAL relay, or the production relay through the explicit live lane. On
  // production the posting-rights check is read-only unless a public note is
  // admitted below. Enforced rather than merely documented.
  const relayRefusal = liveRelaySkipReason(caps.messaging?.relay_url, 1059);
  test.skip(relayRefusal !== null, relayRefusal ?? '');

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
    // When the operator sells plans, the refusal must offer a way to act on
    // it: buy, or redeem an invoice already paid.
    if (await page.getByTestId('feed-premium-plans').isVisible().catch(() => false)) {
      const act = page.getByTestId('premium-buy').or(page.getByTestId('premium-redeem'));
      await expect(act, 'plans are listed but there is no way to buy one').toBeVisible();
    }
    footage.mark('feed-posting-refused', 'server says no; UI explains why');
    return;
  }

  // Allowed by the server. A public note on a production relay additionally
  // needs the owner's approval for this run; without it the check above is the
  // whole test, and nothing is published.
  const noteRefusal = liveRelaySkipReason(caps.messaging?.relay_url, 1, { premium: true });
  if (noteRefusal !== null) {
    test.info().annotations.push({ type: 'not-exercised', description: noteRefusal });
    footage.mark('feed-posting-allowed', 'server grants posting; no public note approved');
    return;
  }

  // Publish for real and require it to come back from the relay.
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
