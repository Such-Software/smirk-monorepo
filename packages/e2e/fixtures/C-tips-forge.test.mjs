// Offline proof that the forge builds the attacks the live forged-wrap scenario
// relies on, and that the wallet's own Inbox rule (rebuild from the backend
// record, keep a candidate only if its claim key opens the sealed tip key)
// drops them without shadowing the genuine tip. No relay, no backend, no funds.
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

/** The wallet's Inbox rule (popup/index.tsx fetchPersonTipInbox), per tip id. */
function inboxPick(received, encryptedKeyByTip) {
  const byTip = new Map();
  for (const t of received) byTip.set(t.tipId, [...(byTip.get(t.tipId) ?? []), t]);
  const rows = [];
  for (const [tipId, candidates] of byTip) {
    const encrypted = encryptedKeyByTip.get(tipId);
    if (!encrypted) continue; // the backend does not know this tip
    const genuine = candidates.find((c) => verifyNpubTipKey(encrypted, c.claimKey));
    if (genuine) rows.push(genuine);
  }
  return rows;
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

  const rows = inboxPick(received, new Map([[tip.tipId, tip.encryptedKeyHex]]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].counterpartyHex, alice.pubkeyHex, 'the genuine sender wins');
  assert.equal(rows[0].memo, 'genuine message');
  assert.equal(rows.some((r) => r.memo === 'forged marker'), false);
  for (const id of [alice, bob]) id.privateKey.fill(0);
});

test('an unknown-tip-id forgery names a fresh id the Inbox drops for want of a backend record', async () => {
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
  assert.equal(inboxPick(received, new Map([[known.tipId, known.encryptedKeyHex]])).length, 0);
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
