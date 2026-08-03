/**
 * NIP-59 gift-wrap of payment payloads (P3): the Goblin-interoperable crypto
 * heart. Proves: a wrap round-trips to the exact payload; the outer 1059 leaks
 * neither sender nor content (ephemeral author, `p`-tag only); a wrong recipient
 * cannot open it; and the payload schema validates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateBurnerIdentity } from '../identity';
import { wrapPayment, unwrapPayment } from '../giftwrap';
import { GIFT_WRAP_KIND, parsePaymentPayload, type PaymentPayload } from '../payments';

const alice = generateBurnerIdentity();
const bob = generateBurnerIdentity();
const mallory = generateBurnerIdentity();

const offer: PaymentPayload = {
  type: 'grin-slatepack',
  v: 1,
  role: 'offer',
  slateId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  slatepack: 'BEGINSLATEPACK. abc123 xyz. ENDSLATEPACK.',
  amount: 250_000_000,
  memo: 'thanks',
};

test('round-trips a grin offer from alice to bob', () => {
  const wrap = wrapPayment(alice, bob.pubkeyHex, offer);
  const opened = unwrapPayment(bob, wrap);
  assert.deepEqual(opened.payload, offer);
  assert.equal(opened.senderPubkeyHex, alice.pubkeyHex); // authenticated inner sender
});

test('the outer 1059 hides sender + content, exposes only the recipient p-tag', () => {
  const wrap = wrapPayment(alice, bob.pubkeyHex, offer);
  assert.equal(wrap.kind, GIFT_WRAP_KIND);
  // Ephemeral author, NOT alice.
  assert.notEqual(wrap.pubkey, alice.pubkeyHex);
  // Content is ciphertext: the slatepack/slateId must not appear in the clear.
  assert.ok(!wrap.content.includes(offer.slateId));
  assert.ok(!wrap.content.includes('BEGINSLATEPACK'));
  // Routable to bob.
  const pTag = wrap.tags.find((t) => t[0] === 'p');
  assert.equal(pTag?.[1], bob.pubkeyHex);
});

test('a wrong recipient cannot open the wrap', () => {
  const wrap = wrapPayment(alice, bob.pubkeyHex, offer);
  assert.throws(() => unwrapPayment(mallory, wrap));
});

test('a tip payload round-trips', () => {
  const tip: PaymentPayload = { type: 'tip', v: 1, asset: 'grin', amount: 1_000_000, memo: 'gg' };
  const wrap = wrapPayment(alice, bob.pubkeyHex, tip);
  assert.deepEqual(unwrapPayment(bob, wrap).payload, tip);
});

test('parsePaymentPayload rejects junk + enforces required fields', () => {
  assert.throws(() => parsePaymentPayload('not json'));
  assert.throws(() => parsePaymentPayload(JSON.stringify({ type: 'nope' })));
  // offer without a slatepack is invalid…
  assert.throws(() =>
    parsePaymentPayload(JSON.stringify({ type: 'grin-slatepack', v: 1, role: 'offer', slateId: 'x' })),
  );
  // …but a cancel without one is fine (terminal notice).
  const cancel = parsePaymentPayload(
    JSON.stringify({ type: 'grin-slatepack', v: 1, role: 'cancel', slateId: 'x' }),
  );
  assert.equal(cancel.type === 'grin-slatepack' && cancel.role, 'cancel');
  // tip needs a positive amount.
  assert.throws(() => parsePaymentPayload(JSON.stringify({ type: 'tip', v: 1, asset: 'grin', amount: 0 })));
});
