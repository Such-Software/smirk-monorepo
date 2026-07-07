/**
 * Channel construction + unified inbox read (P3b): sends route to the right
 * transport, both inboxes merge into one list, a slateId on both is deduped
 * (Nostr wins), and one transport failing doesn't sink the other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readAllInbound, sendSlatepack, type SlatepackChannels } from '../channels';
import type { InboundSlatepack } from '../slatepack-channel';

function stubChannels(over: {
  nostrInbox?: () => Promise<InboundSlatepack[]>;
  backendInbox?: () => Promise<InboundSlatepack[]>;
  onNostrDeliver?: (m: unknown) => void;
  onBackendDeliver?: (m: unknown) => void;
}): SlatepackChannels {
  return {
    nostr: {
      kind: 'nostr',
      deliver: async (m) => {
        over.onNostrDeliver?.(m);
        return { id: 'n' };
      },
      inbox: over.nostrInbox ?? (async () => []),
      respond: async () => {},
      cancel: async () => {},
    } as never,
    backend: {
      kind: 'backend',
      deliver: async (m) => {
        over.onBackendDeliver?.(m);
        return { id: 'b' };
      },
      inbox: over.backendInbox ?? (async () => []),
      respond: async () => {},
      cancel: async () => {},
    } as never,
  };
}

const item = (over: Partial<InboundSlatepack>): InboundSlatepack => ({
  channel: 'nostr',
  id: 's1',
  slateId: 's1',
  counterpartyRef: 'x',
  slatepack: 'sp',
  amountNanogrin: 1,
  createdAt: 100,
  stage: 'to-sign',
  ...over,
});

test('sendSlatepack routes to Nostr when npub-addressable, else backend', async () => {
  let nostrHit = false;
  let backendHit = false;
  const chans = stubChannels({ onNostrDeliver: () => (nostrHit = true), onBackendDeliver: () => (backendHit = true) });

  await sendSlatepack(chans, { pubkeyHex: 'ab', userId: 'u' }, { slateId: 's1', slatepack: 'x', amountNanogrin: 1 });
  assert.equal(nostrHit, true);
  assert.equal(backendHit, false);

  nostrHit = false;
  await sendSlatepack(chans, { userId: 'u' }, { slateId: 's1', slatepack: 'x', amountNanogrin: 1 });
  assert.equal(backendHit, true);
  assert.equal(nostrHit, false);
});

test('readAllInbound merges both inboxes, newest first', async () => {
  const chans = stubChannels({
    nostrInbox: async () => [item({ slateId: 'n1', channel: 'nostr', createdAt: 200 })],
    backendInbox: async () => [item({ slateId: 'b1', channel: 'backend', createdAt: 100 })],
  });
  const all = await readAllInbound(chans);
  assert.deepEqual(all.map((i) => i.slateId), ['n1', 'b1']); // sorted desc by createdAt
});

test('readAllInbound dedups a shared slateId, Nostr wins', async () => {
  const chans = stubChannels({
    nostrInbox: async () => [item({ slateId: 'dup', channel: 'nostr' })],
    backendInbox: async () => [item({ slateId: 'dup', channel: 'backend' })],
  });
  const all = await readAllInbound(chans);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.channel, 'nostr');
});

test('readAllInbound survives one transport throwing', async () => {
  const chans = stubChannels({
    nostrInbox: async () => {
      throw new Error('relay down');
    },
    backendInbox: async () => [item({ slateId: 'b1', channel: 'backend' })],
  });
  const all = await readAllInbound(chans);
  assert.deepEqual(all.map((i) => i.slateId), ['b1']);
});
