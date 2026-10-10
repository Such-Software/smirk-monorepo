// Offline proof that the forge builds the attacks the live forged-wrap scenario
// relies on: each is a valid PoW gift wrap that bob's real reader
// (@smirk/core readNpubTips) opens and keeps as a candidate, and whose claim key
// the app's own check (@smirk/core verifyNpubTipKey) rejects. The Inbox's
// selection rule itself (popup/index.tsx fetchPersonTipInbox: rebuild from the
// backend record, keep only a candidate whose key verifies) is not copied here;
// the live Inbox test exercises it in the release build, after proving the relay
// serves both forgeries to bob and that his Inbox queried for them. No relay,
// no backend, no funds.
//
//   node --import tsx --test packages/e2e/fixtures/C-tips-forge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';
import {
  createPublicTipPayload,
  deliverNpubTip,
  generateBurnerIdentity,
  generatePrivateKey,
  generateUrlFragmentKey,
  readNpubTips,
  verifyNpubTipKey,
} from '@smirk/core';
import { FORGE_POW_BITS, forgeTipWrap, wrapPow } from './nostr-forge.ts';

/** In-memory relay I/O: everything published lands in one shared list. */
function memoryIO(identity, events) {
  return {
    identity,
    async publish(_relays, event) {
      events.push(event);
    },
    async query(_relays, filters) {
      const want = filters[0]?.['#p']?.[0];
      return events.filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === want));
    },
    async outboundRelays() {
      return ['ws://relay.invalid'];
    },
    async inboxRelays() {
      return ['ws://relay.invalid'];
    },
  };
}

/** A real link tip's sealed key, as the backend stores it. */
function genuineTip() {
  const fragment = generateUrlFragmentKey();
  const tipKey = generatePrivateKey();
  const encryptedKeyHex = createPublicTipPayload(tipKey, fragment.bytes);
  tipKey.fill(0);
  return { tipId: randomUUID(), claimKey: fragment.encoded, encryptedKeyHex };
}

test('a reused-tip-id forgery is a valid PoW gift wrap that opens but cannot claim, and never shadows the genuine tip', async () => {
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const tip = genuineTip();
  const events = [];
  await deliverNpubTip(memoryIO(alice, events), bob.pubkeyHex, {
    tipId: tip.tipId,
    claimKey: tip.claimKey,
    asset: 'btc',
    amount: 3000,
    memo: 'genuine message',
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
  });

  const forged = forgeTipWrap({
    recipientPubkeyHex: bob.pubkeyHex,
    kind: 'reused-tip-id',
    tipId: tip.tipId,
    encryptedKeyHex: tip.encryptedKeyHex,
    asset: 'btc',
    amount: 99_999_999,
    memo: 'forged marker',
  });
  assert.equal(forged.event.kind, 1059);
  assert.equal(verifyEvent(forged.event), true, 'the wrap is validly signed');
  assert.ok(wrapPow(forged.event) >= FORGE_POW_BITS, 'the wrap carries the relay PoW floor');
  assert.deepEqual(forged.event.tags.find((t) => t[0] === 'p'), ['p', bob.pubkeyHex]);
  assert.ok(forged.event.created_at <= Math.floor(Date.now() / 1000), 'NIP-59 backdating is kept');
  assert.notEqual(forged.event.pubkey, forged.burnerPubkeyHex, 'wrap key and seal author are distinct');
  events.push(forged.event);

  const { received } = await readNpubTips(memoryIO(bob, events));
  const sameId = received.filter((t) => t.tipId === tip.tipId);
  assert.equal(sameId.length, 2, 'both candidates survive the read, keyed by tip id and claim key');
  const forgedCandidate = sameId.find((t) => t.counterpartyHex === forged.burnerPubkeyHex);
  assert.ok(forgedCandidate, 'the forged wrap opens for the recipient');
  assert.equal(verifyNpubTipKey(tip.encryptedKeyHex, forgedCandidate.claimKey), false, 'its key cannot open the tip');

  // The core facts the app's rule stands on: the genuine candidate's key opens
  // the backend's sealed key, the forged one's does not, and the reader keeps
  // both (keyed by tip id AND claim key), so the forgery cannot shadow it.
  const genuineCandidate = sameId.find((t) => t.counterpartyHex === alice.pubkeyHex);
  assert.ok(genuineCandidate, 'the genuine wrap survives beside the forgery');
  assert.equal(verifyNpubTipKey(tip.encryptedKeyHex, genuineCandidate.claimKey), true, 'the genuine key opens the tip');
  assert.equal(genuineCandidate.memo, 'genuine message');
  for (const id of [alice, bob]) id.privateKey.fill(0);
});

test('an unknown-tip-id forgery names a fresh id whose key opens no real tip', async () => {
  const bob = generateBurnerIdentity();
  const known = genuineTip();
  const forged = forgeTipWrap({
    recipientPubkeyHex: bob.pubkeyHex,
    kind: 'unknown-tip-id',
    asset: 'xmr',
    amount: 5_000_000_000,
    memo: 'forged marker',
  });
  assert.match(forged.tipId, /^[0-9a-f-]{36}$/);
  assert.notEqual(forged.tipId, known.tipId);
  const { received } = await readNpubTips(memoryIO(bob, [forged.event]));
  assert.equal(received.length, 1, 'the wrap opens');
  assert.equal(received[0].tipId, forged.tipId, 'it names the fresh id, which the live test proves the backend does not know');
  assert.equal(verifyNpubTipKey(known.encryptedKeyHex, received[0].claimKey), false, 'its key opens no real tip either');
  bob.privateKey.fill(0);
});

test('the PoW floor is configurable and zero means no nonce tag', () => {
  const bob = generateBurnerIdentity();
  const plain = forgeTipWrap({ recipientPubkeyHex: bob.pubkeyHex, kind: 'unknown-tip-id', asset: 'btc', amount: 1, memo: 'x', powBits: 0 });
  assert.equal(plain.event.tags.some((t) => t[0] === 'nonce'), false);
  const harder = forgeTipWrap({ recipientPubkeyHex: bob.pubkeyHex, kind: 'unknown-tip-id', asset: 'btc', amount: 1, memo: 'x', powBits: 12 });
  assert.ok(wrapPow(harder.event) >= 12);
  assert.throws(() => forgeTipWrap({ recipientPubkeyHex: 'not-hex', kind: 'unknown-tip-id', asset: 'btc', amount: 1, memo: 'x' }));
  assert.throws(() => forgeTipWrap({ recipientPubkeyHex: bob.pubkeyHex, kind: 'reused-tip-id', asset: 'btc', amount: 1, memo: 'x' }));
  bob.privateKey.fill(0);
});
