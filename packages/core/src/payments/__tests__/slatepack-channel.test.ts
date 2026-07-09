/**
 * SlatepackChannel seam (P3): the backend-relay adapter and the Nostr gift-wrap
 * channel behind one interface. The Nostr channel uses INJECTED relay I/O — the
 * fake below is an in-memory relay, so we exercise deliver → the counterparty's
 * inbox → respond → the original sender's inbox → cancel with real gift-wrap
 * crypto and no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateBurnerIdentity } from '../../nostr/identity';
import type { NostrWireEvent, NostrFilter } from '../../nostr/client';
import {
  BackendRelayChannel,
  NostrGiftwrapChannel,
  selectSendChannel,
  type NostrChannelIO,
  type SlatepackChannel,
} from '../slatepack-channel';

// ── an in-memory Nostr relay for the injected I/O ───────────────────────────
function fakeRelay() {
  const events: NostrWireEvent[] = [];
  const ioFor = (identity: ReturnType<typeof generateBurnerIdentity>): NostrChannelIO => ({
    identity,
    async publish(_relays, event) {
      events.push(event);
    },
    async query(_relays, filters: NostrFilter[]) {
      return events.filter((e) =>
        filters.some(
          (f) =>
            (!f.kinds || f.kinds.includes(e.kind)) &&
            (!f['#p'] || e.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1]))),
        ),
      );
    },
    async outboundRelays() {
      return ['wss://relay.test'];
    },
    async inboxRelays() {
      return ['wss://relay.test'];
    },
  });
  return { events, ioFor };
}

const SLATE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

test('nostr channel: deliver → recipient inbox shows a to-sign offer', async () => {
  const relay = fakeRelay();
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const aliceCh = new NostrGiftwrapChannel(relay.ioFor(alice));
  const bobCh = new NostrGiftwrapChannel(relay.ioFor(bob));

  await aliceCh.deliver({
    slateId: SLATE,
    slatepack: 'S1_ARMORED',
    amountNanogrin: 250_000_000,
    recipientPubkeyHex: bob.pubkeyHex,
  });

  const inbox = await bobCh.inbox();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.stage, 'to-sign');
  assert.equal(inbox[0]!.slateId, SLATE);
  assert.equal(inbox[0]!.slatepack, 'S1_ARMORED');
  assert.equal(inbox[0]!.counterpartyRef, alice.pubkeyHex);
  // Alice (the sender) sees nothing pending — the offer isn't addressed to her.
  assert.equal((await aliceCh.inbox()).length, 0);
});

test('nostr channel: respond → original sender inbox shows to-finalize', async () => {
  const relay = fakeRelay();
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const aliceCh = new NostrGiftwrapChannel(relay.ioFor(alice));
  const bobCh = new NostrGiftwrapChannel(relay.ioFor(bob));

  await aliceCh.deliver({ slateId: SLATE, slatepack: 'S1', amountNanogrin: 1, recipientPubkeyHex: bob.pubkeyHex });
  const bobInbox = await bobCh.inbox();
  // Bob responds to alice (counterpartyRef from his inbox item).
  await bobCh.respond(SLATE, 'S2_ARMORED', bobInbox[0]!.counterpartyRef);

  const aliceInbox = await aliceCh.inbox();
  assert.equal(aliceInbox.length, 1);
  assert.equal(aliceInbox[0]!.stage, 'to-finalize');
  assert.equal(aliceInbox[0]!.slatepack, 'S2_ARMORED');
  assert.equal(aliceInbox[0]!.counterpartyRef, bob.pubkeyHex);
});

test('nostr channel: settle retires the slateId on BOTH the recipient and the sender', async () => {
  const relay = fakeRelay();
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const aliceCh = new NostrGiftwrapChannel(relay.ioFor(alice));
  const bobCh = new NostrGiftwrapChannel(relay.ioFor(bob));

  // Full exchange: alice offers → bob responds → alice's inbox shows to-finalize.
  await aliceCh.deliver({ slateId: SLATE, slatepack: 'S1', amountNanogrin: 1, recipientPubkeyHex: bob.pubkeyHex });
  const bobInbox = await bobCh.inbox();
  await bobCh.respond(SLATE, 'S2', bobInbox[0]!.counterpartyRef);
  assert.equal((await aliceCh.inbox()).length, 1, 'alice has a to-finalize before settle');

  // Alice broadcasts and settles (addressed to bob). Without self-addressing,
  // alice's own inbox would still resolve the slateId to to-finalize forever.
  await aliceCh.settle(SLATE, bob.pubkeyHex);

  assert.equal((await bobCh.inbox()).length, 0, 'recipient inbox retired');
  assert.equal((await aliceCh.inbox()).length, 0, 'sender inbox retired via self-addressed finalize');
});

test('nostr channel: cancel retires the slateId from the recipient inbox', async () => {
  const relay = fakeRelay();
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const aliceCh = new NostrGiftwrapChannel(relay.ioFor(alice));
  const bobCh = new NostrGiftwrapChannel(relay.ioFor(bob));

  await aliceCh.deliver({ slateId: SLATE, slatepack: 'S1', amountNanogrin: 1, recipientPubkeyHex: bob.pubkeyHex });
  assert.equal((await bobCh.inbox()).length, 1);
  // Alice cancels (addressed to bob); the newer terminal role supersedes the offer.
  await aliceCh.cancel(SLATE, bob.pubkeyHex);
  assert.equal((await bobCh.inbox()).length, 0);
});

test('nostr channel: deliver requires a recipient pubkey; respond/cancel require the counterparty', async () => {
  const relay = fakeRelay();
  const ch = new NostrGiftwrapChannel(relay.ioFor(generateBurnerIdentity()));
  await assert.rejects(() => ch.deliver({ slateId: SLATE, slatepack: 'x', amountNanogrin: 1 }), /recipientPubkeyHex/);
  await assert.rejects(() => ch.respond(SLATE, 'x'), /counterparty/);
  await assert.rejects(() => ch.cancel(SLATE), /counterparty/);
});

test('nostr channel: a tip rides the same rail and does not appear as a slatepack', async () => {
  const relay = fakeRelay();
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const aliceCh = new NostrGiftwrapChannel(relay.ioFor(alice));
  const bobCh = new NostrGiftwrapChannel(relay.ioFor(bob));

  await aliceCh.deliverTip(bob.pubkeyHex, { asset: 'grin', amount: 1_000_000, memo: 'gg' });
  // The tip is a 1059 addressed to bob…
  assert.equal(relay.events.length, 1);
  assert.equal(relay.events[0]!.kind, 1059);
  // …but it is not a slatepack, so the slatepack inbox stays empty.
  assert.equal((await bobCh.inbox()).length, 0);
});

// ── backend channel over a fake GrinMethods ─────────────────────────────────
function fakeGrin(overrides: Record<string, unknown> = {}) {
  return {
    async createGrinRelay() {
      return { data: { id: SLATE, expires_at: '2026-01-01T00:00:00Z' } };
    },
    async getGrinPendingSlatepacks() {
      return {
        data: {
          pending_to_sign: [
            { id: SLATE, slate_id: SLATE, sender_user_id: 'u-alice', amount: 42, slatepack: 'S1', created_at: '2026-07-07T00:00:00Z', expires_at: '2026-07-08T00:00:00Z' },
          ],
          pending_to_finalize: [],
        },
      };
    },
    async signGrinSlatepack() {
      return { data: { success: true } };
    },
    async cancelGrinSlatepack() {
      return { data: { success: true } };
    },
    async finalizeGrinSlatepack() {
      return { data: { broadcast: true } };
    },
    ...overrides,
  } as never;
}

test('backend channel: deliver/inbox/respond/cancel map to the v3 grin API', async () => {
  const ch: SlatepackChannel = new BackendRelayChannel({ grin: fakeGrin(), userId: 'u-bob' });
  const { id } = await ch.deliver({ slateId: SLATE, slatepack: 'S1', amountNanogrin: 42, recipientUserId: 'u-alice' });
  assert.equal(id, SLATE);

  const inbox = await ch.inbox();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.channel, 'backend');
  assert.equal(inbox[0]!.stage, 'to-sign');
  assert.equal(inbox[0]!.counterpartyRef, 'u-alice');
  assert.equal(inbox[0]!.amountNanogrin, 42);

  await ch.respond(SLATE, 'S2'); // no throw
  await ch.cancel(SLATE); // no throw
});

test('backend channel: settle flips the relay row via relay/finalize (best-effort)', async () => {
  let called = false;
  const ch = new BackendRelayChannel({
    grin: fakeGrin({
      finalizeGrinSlatepack: async () => {
        called = true;
        return { data: { broadcast: true } };
      },
    }),
    userId: 'u-bob',
  });
  await ch.settle(SLATE);
  assert.equal(called, true);
  // A finalize failure must not throw (never undo an on-chain broadcast).
  const errCh = new BackendRelayChannel({
    grin: fakeGrin({ finalizeGrinSlatepack: async () => ({ error: 'boom' }) }),
    userId: 'u-bob',
  });
  await errCh.settle(SLATE); // no throw
});

test('backend channel: deliver without a recipientUserId throws; errors surface', async () => {
  const ch = new BackendRelayChannel({ grin: fakeGrin(), userId: 'u-bob' });
  await assert.rejects(() => ch.deliver({ slateId: SLATE, slatepack: 'x', amountNanogrin: 1 }), /recipientUserId/);

  const errCh = new BackendRelayChannel({
    grin: fakeGrin({ signGrinSlatepack: async () => ({ error: 'boom' }) }),
    userId: 'u-bob',
  });
  await assert.rejects(() => errCh.respond(SLATE, 'x'), /boom/);
});

test('selectSendChannel prefers Nostr when the recipient is npub-addressable', () => {
  const nostr = new NostrGiftwrapChannel(fakeRelay().ioFor(generateBurnerIdentity()));
  const backend = new BackendRelayChannel({ grin: fakeGrin(), userId: 'u' });
  assert.equal(selectSendChannel({ pubkeyHex: 'ab', userId: 'u' }, { nostr, backend }), nostr);
  assert.equal(selectSendChannel({ userId: 'u' }, { nostr, backend }), backend);
  assert.throws(() => selectSendChannel({}, { nostr, backend }), /no channel/);
});
