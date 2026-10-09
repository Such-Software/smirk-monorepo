/**
 * Tips to an npub: delivery over a gift wrap, the sender's self-addressed
 * history copy, and the key check that rejects forged wraps. Uses an in-memory
 * relay and real gift-wrap and tip-seal crypto, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateBurnerIdentity } from '../../nostr/identity';
import type { NostrWireEvent, NostrFilter } from '../../nostr/client';
import { wrapPayment } from '../../nostr/giftwrap';
import { parsePaymentPayload } from '../../nostr/payments';
import { nip44Decrypt } from '../../nostr/nip07';
import { createPublicTipPayload, generateUrlFragmentKey, randomBytes } from '../../crypto';
import type { NostrChannelIO } from '../slatepack-channel';
import {
  deliverNpubTip,
  openNpubTipClaimKey,
  readNpubTips,
  sealNpubTipClaimKey,
  verifyNpubTipKey,
} from '../npub-tips';

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

const TIP_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** A real sealed tip key, as the backend would store it, plus its claim key. */
function sealedTip() {
  const claim = generateUrlFragmentKey();
  const tipPrivateKey = randomBytes(32);
  // createPublicTipPayload returns the hex the backend stores as encrypted_key.
  const encryptedKeyHex = createPublicTipPayload(tipPrivateKey, claim.bytes);
  return { claimKey: claim.encoded, encryptedKeyHex };
}

test('npub tip: recipient reads it as received, sender reads it as sent', async () => {
  const relay = fakeRelay();
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const { claimKey } = sealedTip();

  const result = await deliverNpubTip(relay.ioFor(alice), bob.pubkeyHex, {
    tipId: TIP_ID,
    claimKey,
    asset: 'xmr',
    amount: 1_000_000_000,
    memo: 'thanks',
    expiresAt: 1_900_000_000,
  });
  assert.equal(result.selfCopy, true);

  const bobView = await readNpubTips(relay.ioFor(bob));
  assert.equal(bobView.received.length, 1);
  assert.equal(bobView.sent.length, 0);
  const got = bobView.received[0]!;
  assert.equal(got.tipId, TIP_ID);
  assert.equal(got.claimKey, claimKey);
  assert.equal(got.counterpartyHex, alice.pubkeyHex);
  assert.equal(got.memo, 'thanks');
  assert.equal(got.expiresAt, 1_900_000_000);

  const aliceView = await readNpubTips(relay.ioFor(alice));
  assert.equal(aliceView.received.length, 0);
  assert.equal(aliceView.sent.length, 1);
  assert.equal(aliceView.sent[0]!.counterpartyHex, bob.pubkeyHex);
});

test('npub tip: a third party cannot read the claim key', async () => {
  const relay = fakeRelay();
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const eve = generateBurnerIdentity();
  const { claimKey } = sealedTip();
  await deliverNpubTip(relay.ioFor(alice), bob.pubkeyHex, { tipId: TIP_ID, claimKey, asset: 'btc', amount: 5000 });

  const eveView = await readNpubTips(relay.ioFor(eve));
  assert.equal(eveView.received.length + eveView.sent.length, 0);
  // Nothing on the wire carries the key in the clear.
  assert.ok(relay.events.every((e) => !JSON.stringify(e).includes(claimKey)));
});

test('npub tip: the claim key verifies only against its own sealed key', () => {
  const genuine = sealedTip();
  const other = sealedTip();
  assert.equal(verifyNpubTipKey(genuine.encryptedKeyHex, genuine.claimKey), true);
  assert.equal(verifyNpubTipKey(genuine.encryptedKeyHex, other.claimKey), false);
  assert.equal(verifyNpubTipKey(null, genuine.claimKey), false);
  assert.equal(verifyNpubTipKey(genuine.encryptedKeyHex, 'not-a-key'), false);
});

test('npub tip: a forged wrap reusing a real tip id does not shadow the genuine one', async () => {
  const relay = fakeRelay();
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const mallory = generateBurnerIdentity();
  const genuine = sealedTip();
  const forgedKey = sealedTip().claimKey;

  await deliverNpubTip(relay.ioFor(alice), bob.pubkeyHex, {
    tipId: TIP_ID,
    claimKey: genuine.claimKey,
    asset: 'ltc',
    amount: 100_000,
  });
  await deliverNpubTip(relay.ioFor(mallory), bob.pubkeyHex, {
    tipId: TIP_ID,
    claimKey: forgedKey,
    asset: 'ltc',
    amount: 999_999_999,
  });

  const { received } = await readNpubTips(relay.ioFor(bob));
  assert.equal(received.length, 2, 'both candidates survive the read');
  const verified = received.filter((t) => verifyNpubTipKey(genuine.encryptedKeyHex, t.claimKey));
  assert.equal(verified.length, 1);
  assert.equal(verified[0]!.counterpartyHex, alice.pubkeyHex);
});

test('npub tip: wraps without a claim key or of another type are skipped', async () => {
  const relay = fakeRelay();
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const io = relay.ioFor(alice);
  // An informational tip (no claim fields) and a Grin slatepack offer.
  await io.publish(['wss://relay.test'], wrapPayment(alice, bob.pubkeyHex, { type: 'tip', v: 1, asset: 'xmr', amount: 1 }));
  await io.publish(
    ['wss://relay.test'],
    wrapPayment(alice, bob.pubkeyHex, { type: 'grin-slatepack', v: 1, role: 'offer', slateId: TIP_ID, slatepack: 'S1' }),
  );
  const { received, sent } = await readNpubTips(relay.ioFor(bob));
  assert.equal(received.length + sent.length, 0);
});

test('tip payload parser drops malformed claim fields instead of trusting them', () => {
  const p = parsePaymentPayload(
    JSON.stringify({
      type: 'tip',
      v: 1,
      asset: 'xmr',
      amount: 5,
      tipId: 'not-a-uuid',
      sealedClaimKey: 'zz',
      expiresAt: -1,
      to: 'zz',
    }),
  );
  assert.equal(p.type, 'tip');
  if (p.type !== 'tip') return;
  assert.equal(p.tipId, undefined);
  assert.equal(p.sealedClaimKey, undefined);
  assert.equal(p.expiresAt, undefined);
  assert.equal(p.to, undefined);
});

/**
 * What a website holding the wallet's NIP-07 grant can do: `nip44.decrypt` with
 * the user's key, once for the gift wrap and once for the seal. Returns every
 * plaintext it would see.
 */
function nip07View(identity: ReturnType<typeof generateBurnerIdentity>, wraps: NostrWireEvent[]): string[] {
  const seen: string[] = [];
  for (const wrap of wraps) {
    try {
      const sealJson = nip44Decrypt(identity, wrap.pubkey, wrap.content);
      seen.push(sealJson);
      const seal = JSON.parse(sealJson) as { pubkey: string; content: string };
      seen.push(nip44Decrypt(identity, seal.pubkey, seal.content));
    } catch {
      // Not addressed to this identity.
    }
  }
  return seen;
}

test('npub tip: the NIP-07 decrypt surface opens the wrap but never yields the claim key', async () => {
  const relay = fakeRelay();
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const { claimKey } = sealedTip();
  await deliverNpubTip(relay.ioFor(alice), bob.pubkeyHex, { tipId: TIP_ID, claimKey, asset: 'btc', amount: 5000 });

  // Received (Bob's grant) and the sender's own history copy (Alice's grant).
  for (const who of [bob, alice]) {
    const plaintexts = nip07View(who, relay.events);
    assert.ok(plaintexts.length >= 2, 'the site really does open the wrap and the seal');
    assert.ok(plaintexts.every((t) => !t.includes(claimKey)), 'no plaintext carries the claim key');
    const rumors = plaintexts.map((t) => JSON.parse(t) as { kind: number; content: string }).filter((e) => e.kind === 14);
    assert.ok(rumors.length >= 1);
    for (const r of rumors) {
      const payload = JSON.parse(r.content) as Record<string, unknown>;
      assert.equal(payload.claimKey, undefined);
      assert.equal(typeof payload.sealedClaimKey, 'string');
    }
  }
  // While the wallet itself still recovers it on both sides.
  assert.equal((await readNpubTips(relay.ioFor(bob))).received[0]?.claimKey, claimKey);
  assert.equal((await readNpubTips(relay.ioFor(alice))).sent[0]?.claimKey, claimKey);
});

test('npub tip: a sealed claim key opens only for its own tip id and its two parties', () => {
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const eve = generateBurnerIdentity();
  const { claimKey } = sealedTip();
  const sealed = sealNpubTipClaimKey(alice.privateKey, bob.pubkeyHex, TIP_ID, claimKey);
  assert.equal(openNpubTipClaimKey(bob.privateKey, alice.pubkeyHex, TIP_ID, sealed), claimKey);
  assert.equal(openNpubTipClaimKey(bob.privateKey, alice.pubkeyHex, '3f2504e0-4f89-41d3-9a0c-0305e82c3302', sealed), null);
  assert.equal(openNpubTipClaimKey(eve.privateKey, alice.pubkeyHex, TIP_ID, sealed), null);
  assert.equal(openNpubTipClaimKey(bob.privateKey, eve.pubkeyHex, TIP_ID, sealed), null);
});

test('npub tip: a wrap carrying a plaintext claim key is not a claimable tip', async () => {
  const relay = fakeRelay();
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const { claimKey } = sealedTip();
  // The pre-release wire shape: the key in the rumor in the clear.
  const legacy = { type: 'tip', v: 1, asset: 'btc', amount: 5000, tipId: TIP_ID, claimKey } as unknown as Parameters<typeof wrapPayment>[2];
  await relay.ioFor(alice).publish(['wss://relay.test'], wrapPayment(alice, bob.pubkeyHex, legacy));
  const { received } = await readNpubTips(relay.ioFor(bob));
  assert.equal(received.length, 0);
});
