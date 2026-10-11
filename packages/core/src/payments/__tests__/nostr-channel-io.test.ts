/**
 * The runtime NostrChannelIO bridge (P3b): proves it delegates to the active
 * MessagingProvider + relay set: publish routes to publishWrap, query routes to
 * the seedless wrap poll keyed on OUR pubkey, and outbound relays fold the
 * recipient's inbox together with ours. A recording fake provider stands in for
 * the relays; end-to-end gift-wrap flow is covered in slatepack-channel.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateBurnerIdentity } from '../../nostr/identity';
import type { MessagingProvider } from '../../messaging/provider';
import { setMessagingProvider, initSmirkMessaging } from '../../messaging/registry';
import { createNostrChannelIO } from '../nostr-channel-io';
import { api, invalidateCapabilities } from '../../api';
import { MAX_WRAP_POW_BITS } from '../../nostr/pow-wrap';
import { deliverNpubTip } from '../npub-tips';
import { generateUrlFragmentKey } from '../../crypto';

function recordingProvider() {
  const calls = { publishWrap: [] as unknown[], queryDmWraps: [] as unknown[] };
  const provider: MessagingProvider = {
    kind: 'fake',
    async sendDm() {},
    subscribeDms() {
      return { close() {} };
    },
    async publishWrap(p) {
      calls.publishWrap.push(p);
    },
    async queryDmWraps(p) {
      calls.queryDmWraps.push(p);
      return [];
    },
    async queryDmRelayList() {
      return ['wss://bob-inbox.example'];
    },
    async publishDmRelayList() {},
    close() {},
  };
  return { provider, calls };
}

test('createNostrChannelIO: publish → provider.publishWrap; query → seedless poll on our npub', async () => {
  const { provider, calls } = recordingProvider();
  setMessagingProvider(provider);
  initSmirkMessaging({ publicRelays: ['wss://ours.example'] });
  const me = generateBurnerIdentity();
  const io = createNostrChannelIO(me);

  const wrap = { id: 'w1', pubkey: 'eph', created_at: 1, kind: 1059, tags: [], content: 'ct', sig: '' };
  await io.publish(['wss://ours.example'], wrap);
  assert.equal(calls.publishWrap.length, 1);
  assert.deepEqual((calls.publishWrap[0] as { wrap: unknown }).wrap, wrap);

  await io.query(['wss://ours.example'], [{ kinds: [1059], '#p': [me.pubkeyHex], since: 42 }]);
  const q = calls.queryDmWraps[0] as { pubkeyHex: string; sinceSec?: number };
  assert.equal(q.pubkeyHex, me.pubkeyHex); // reads OUR inbox
  assert.equal(q.sinceSec, 42);

  assert.deepEqual(await io.inboxRelays(), ['wss://ours.example']);
});

test('createNostrChannelIO: outboundRelays fold the recipient inbox with ours', async () => {
  const { provider } = recordingProvider();
  setMessagingProvider(provider);
  initSmirkMessaging({ publicRelays: ['wss://ours.example'] });
  const io = createNostrChannelIO(generateBurnerIdentity());

  const bob = generateBurnerIdentity();
  const relays = await io.outboundRelays(bob.pubkeyHex);
  assert.ok(relays.includes('wss://bob-inbox.example'), 'targets the recipient inbox');
  assert.ok(relays.includes('wss://ours.example'), 'plus our own relay');
});

test('createNostrChannelIO: powBits reads the relay demand from the cached capabilities', async (t) => {
  const { provider, calls } = recordingProvider();
  setMessagingProvider(provider);
  initSmirkMessaging({ publicRelays: ['wss://ours.example'] });
  const me = generateBurnerIdentity();
  const bob = generateBurnerIdentity();

  // Capabilities are memoized per backend; each case starts from an empty cache.
  const advertise = (messaging: unknown) => {
    invalidateCapabilities();
    return t.mock.method(api, 'getCapabilities', async () => ({ data: { messaging } }) as never);
  };
  const bitsFor = async (messaging: unknown): Promise<number> => {
    const stub = advertise(messaging);
    try {
      return await createNostrChannelIO(me).powBits!();
    } finally {
      stub.mock.restore();
    }
  };

  assert.equal(await bitsFor({ inbound_pow_bits: 8 }), 8, 'the advertised demand is what gets mined');
  assert.equal(await bitsFor(undefined), 0, 'a backend without a relay asks for nothing');
  assert.equal(await bitsFor({ inbound_pow_bits: 0 }), 0);
  assert.equal(await bitsFor({ inbound_pow_bits: 7.5 }), 0, 'a malformed figure is not mined');

  // An excessive demand passes through unclamped, so the tip is refused at once
  // with the figure instead of freezing the wallet only to be refused anyway.
  const excessive = MAX_WRAP_POW_BITS + 4;
  assert.equal(await bitsFor({ inbound_pow_bits: excessive }), excessive);
  const stub = advertise({ inbound_pow_bits: excessive });
  try {
    const started = Date.now();
    await assert.rejects(
      deliverNpubTip(createNostrChannelIO(me), bob.pubkeyHex, {
        tipId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        claimKey: generateUrlFragmentKey().encoded,
        asset: 'xmr',
        amount: 1_000_000_000,
      }),
      (e: unknown) => e instanceof Error && e.message.includes(String(excessive)),
    );
    assert.ok(Date.now() - started < 2_000, 'refused before any mining');
    assert.equal(calls.publishWrap.length, 0, 'nothing reached a relay');
  } finally {
    stub.mock.restore();
    invalidateCapabilities();
  }
});
