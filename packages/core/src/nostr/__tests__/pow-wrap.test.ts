/**
 * Payment gift wraps carry the relay's NIP-13 proof-of-work.
 *
 * A wrap's outer signer is an ephemeral key, so the relay sees every wrap as
 * coming from an unknown author and applies its inbound proof-of-work rule to
 * tips and Grin slatepacks exactly as to DMs. The live v0.3.1 run had npub tips
 * refused with "insufficient proof-of-work for cross-ecosystem delivery" because
 * payment wraps were published unmined. These tests pin the fix: the wrap meets
 * the difficulty, still opens to the same authenticated payload, and keeps
 * NIP-59's backdated timestamp; the runtime channel asks for the bits; and both
 * payment senders (npub tips, slatepack channel) pass them through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPow } from 'nostr-tools/nip13';

import { generateBurnerIdentity } from '../identity';
import { wrapPayment, unwrapPayment } from '../giftwrap';
import type { PaymentPayload } from '../payments';
import type { NostrWireEvent, NostrFilter } from '../client';
import type { NostrChannelIO } from '../../payments/slatepack-channel';
import { NostrGiftwrapChannel } from '../../payments/slatepack-channel';
import { deliverNpubTip } from '../../payments/npub-tips';
import { createPublicTipPayload, generateUrlFragmentKey, randomBytes } from '../../crypto';

const alice = generateBurnerIdentity();
const bob = generateBurnerIdentity();

const tip: PaymentPayload = {
  type: 'tip',
  v: 1,
  asset: 'xmr',
  amount: 1_000_000_000,
  memo: 'pow test',
};

test('a payment wrap mined for 8 bits meets the difficulty and still opens', () => {
  const wrap = wrapPayment(alice, bob.pubkeyHex, tip, 8);
  assert.ok(getPow(wrap.id) >= 8, `wrap id has ${getPow(wrap.id)} leading zero bits`);
  assert.ok(wrap.tags.some((t) => t[0] === 'nonce' && t[2] === '8'), 'carries a NIP-13 nonce tag');
  assert.ok(wrap.tags.some((t) => t[0] === 'p' && t[1] === bob.pubkeyHex), 'still routed to bob');
  const opened = unwrapPayment(bob, wrap);
  assert.equal(opened.senderPubkeyHex, alice.pubkeyHex);
  assert.deepEqual(opened.payload, tip);
  assert.notEqual(wrap.pubkey, alice.pubkeyHex, 'outer signer stays ephemeral');
});

test('mining keeps the NIP-59 backdated timestamp instead of resetting it to now', () => {
  const now = Math.floor(Date.now() / 1000);
  // With a random backdate over 48 h, 20 wraps all landing within 5 s of now is vanishingly unlikely.
  const near = Array.from({ length: 20 }, () => wrapPayment(alice, bob.pubkeyHex, tip, 4)).filter(
    (w) => now - w.created_at < 5,
  );
  assert.ok(near.length < 20, 'timestamps are backdated, not the mining second');
});

test('without bits the wrap is unchanged (no nonce tag)', () => {
  const wrap = wrapPayment(alice, bob.pubkeyHex, tip);
  assert.ok(!wrap.tags.some((t) => t[0] === 'nonce'));
  assert.deepEqual(unwrapPayment(bob, wrap).payload, tip);
});

function relay(bits: number) {
  const events: NostrWireEvent[] = [];
  const ioFor = (identity: ReturnType<typeof generateBurnerIdentity>): NostrChannelIO => ({
    identity,
    async publish(_relays, event) {
      // Behave like our relay: refuse a wrap without the advertised proof-of-work.
      if (bits > 0 && getPow(event.id) < bits) throw new Error('insufficient proof-of-work for cross-ecosystem delivery');
      events.push(event);
    },
    async query(_relays, filters: NostrFilter[]) {
      return events.filter((e) => filters.some((f) => !f['#p'] || e.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1]))));
    },
    async outboundRelays() {
      return ['wss://relay.test'];
    },
    async inboxRelays() {
      return ['wss://relay.test'];
    },
    async powBits() {
      return bits;
    },
  });
  return { events, ioFor };
}

test('an npub tip reaches a relay that requires 8 bits, recipient and self copy', async () => {
  const r = relay(8);
  const claim = generateUrlFragmentKey();
  createPublicTipPayload(randomBytes(32), claim.bytes);
  const result = await deliverNpubTip(r.ioFor(alice), bob.pubkeyHex, {
    tipId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    claimKey: claim.encoded,
    asset: 'xmr',
    amount: '0.001',
  } as Parameters<typeof deliverNpubTip>[2]);
  assert.equal(result.selfCopy, true);
  assert.equal(r.events.length, 2);
  for (const e of r.events) assert.ok(getPow(e.id) >= 8);
});

test('a Grin slatepack offer reaches a relay that requires 8 bits', async () => {
  const r = relay(8);
  const channel = new NostrGiftwrapChannel(r.ioFor(alice));
  await channel.deliverTip(bob.pubkeyHex, {
    tipId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    asset: 'grin',
    amount: '1',
    sealedClaimKey: 'y'.repeat(40),
  } as Parameters<typeof channel.deliverTip>[1]);
  assert.equal(r.events.length, 1);
  assert.ok(getPow(r.events[0]!.id) >= 8);
});
