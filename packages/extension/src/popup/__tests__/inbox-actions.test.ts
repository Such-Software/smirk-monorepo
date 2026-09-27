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
import { GrinPendingOverlay, createMemoryGrinPendingStore, generateMnemonicPhrase, NostrGiftwrapChannel } from '@smirk/core';
import { freeInboxReservedInputs, cancelInboxItem, respondToInboxItem } from '../inbox-actions';
import { encodeNostrRelayRef } from '../relay-ref';
import { storage } from '../singletons';
import { grinOverlay } from '../grin-flows';

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

test('declined signing authorization releases local inputs without signing a cancellation', async (t) => {
  const slateId = crypto.randomUUID();
  const relayId = encodeNostrRelayRef(slateId, 'deadbeef'.repeat(8));
  await grinOverlay.addPending(slateId, { spentCommits: [INPUT_COMMIT] });
  let canceled = false;
  t.mock.method(NostrGiftwrapChannel.prototype, 'cancel', async () => { canceled = true; });
  const result = await cancelInboxItem({
    relayId, userId: 'test-user', mnemonic: generateMnemonicPhrase(),
    beforeSign: async () => { throw new Error('Password confirmation canceled'); },
  });
  assert.ok(result.error);
  assert.equal(canceled, false);
  assert.ok(!(await grinOverlay.selectablePendingSpent()).has(INPUT_COMMIT));
});

for (const action of ['cancel', 'respond'] as const) {
  test(`lock during inbox ${action} identity lookup prevents the signed transport call`, async (t) => {
    const relayId = encodeNostrRelayRef(crypto.randomUUID(), 'deadbeef'.repeat(8));
    let locked = false;
    let signed = false;
    const get = storage.get.bind(storage);
    t.mock.method(storage, 'get', async (key: string) => {
      const value = await get(key);
      if (key.startsWith('smirk_nostr_vault_v1_')) locked = true;
      return value;
    });
    t.mock.method(NostrGiftwrapChannel.prototype, action, async () => { signed = true; });
    const params = {
      relayId, userId: 'test-user', mnemonic: generateMnemonicPhrase(),
      assertSession: () => { if (locked) throw new Error('Wallet locked during identity lookup'); },
    };
    const result = action === 'cancel'
      ? await cancelInboxItem(params)
      : await respondToInboxItem({ ...params, s2Armored: 'test-response' });
    assert.match(result.error ?? '', /locked during identity lookup/);
    assert.equal(signed, false);
  });
}
