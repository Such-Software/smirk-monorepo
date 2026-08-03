/**
 * MONEY-CRITICAL regression: cancelling a `pending_to_finalize` inbox row must
 * free the send's build-time-reserved inputs (same as the wizard's
 * cancelGrinSend), or they stay excluded from selection until the 7-day age-out
 * (stuck funds). The pre-broadcast guard must still refuse to free a tx that has
 * already broadcast (double-spend). Covered here via the injectable overlay seam
 * on freeInboxReservedInputs; the transport side (channelsFor) needs the network
 * and is exercised elsewhere.
 */
import './_chrome-stub'; // MUST be first: installs chrome.storage before singletons.ts loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrinPendingOverlay, createMemoryGrinPendingStore } from '@smirk/core';
import { freeInboxReservedInputs } from '../inbox-actions';
import { encodeNostrRelayRef } from '../relay-ref';

const INPUT_COMMIT = '07'.repeat(33);
const SLATE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('Inbox cancel frees a pre-broadcast reservation (backend row = bare slate_id)', async () => {
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  // A delivered-but-unbroadcast send reserved its input at build time.
  await overlay.addPending(SLATE_ID, { spentCommits: [INPUT_COMMIT] });
  assert.ok((await overlay.selectablePendingSpent()).has(INPUT_COMMIT), 'reserved');

  // Backend relayId is the bare slate_id.
  await freeInboxReservedInputs(SLATE_ID, overlay);

  assert.equal(
    (await overlay.selectablePendingSpent()).size,
    0,
    'reserved inputs freed on Inbox cancel (no stuck funds)',
  );
});

test('Inbox cancel frees a pre-broadcast reservation (Nostr row = slateId packed in ref)', async () => {
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  await overlay.addPending(SLATE_ID, { spentCommits: [INPUT_COMMIT] });

  // Nostr relayId packs the slate_id + counterparty pubkey.
  const relayId = encodeNostrRelayRef(SLATE_ID, 'deadbeef'.repeat(8));
  await freeInboxReservedInputs(relayId, overlay);

  assert.equal((await overlay.selectablePendingSpent()).size, 0, 'freed via decoded slateId');
});

test('Inbox cancel does NOT free a tx that already broadcast (double-spend guard)', async () => {
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  await overlay.addPending(SLATE_ID, { spentCommits: [INPUT_COMMIT], broadcast: true });

  await freeInboxReservedInputs(SLATE_ID, overlay);

  assert.ok(
    (await overlay.selectablePendingSpent()).has(INPUT_COMMIT),
    'broadcast inputs stay reserved (freeing them would enable a double-spend)',
  );
});

test('Inbox cancel is a harmless no-op when the row has no reserved entry', async () => {
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  await overlay.addPending('some-other-slate', { spentCommits: [INPUT_COMMIT] });

  await freeInboxReservedInputs(SLATE_ID, overlay);

  // Unrelated entry untouched.
  assert.ok((await overlay.selectablePendingSpent()).has(INPUT_COMMIT));
});
