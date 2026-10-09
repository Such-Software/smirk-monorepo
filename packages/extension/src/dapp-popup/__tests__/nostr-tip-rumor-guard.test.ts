/**
 * A website granted the Nostr scope must not read the wallet's own tip rail.
 *
 * Person tips travel as NIP-17 gift wraps to the user's main Nostr key, and the
 * same key answers `window.nostr.nip44.decrypt` for any granted site, silently
 * after its first crypt prompt. A site can therefore fetch the wraps addressed
 * to the user and decrypt the wrap, then the seal. The shared executor refuses
 * that last step for a claimable tip, whatever the wire shape (sealed claim
 * key, or a pre-release wrap carrying the key in the clear), and leaves
 * ordinary direct messages alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapEvent as wrapDm } from 'nostr-tools/nip17';

import { generateBurnerIdentity, generateUrlFragmentKey, wrapPayment, type TipPayload } from '@smirk/core';
import { nostrCryptWith } from '../signers';

const TIP_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** What the site does with each wrap: decrypt the wrap, then the seal. */
function openAsSite(identity: ReturnType<typeof generateBurnerIdentity>, wrap: { pubkey: string; content: string }) {
  const seal = JSON.parse(nostrCryptWith(identity, 'decrypt', 'nip44', wrap.pubkey, wrap.content)) as {
    kind: number;
    pubkey: string;
    content: string;
  };
  assert.equal(seal.kind, 13, 'the seal layer still opens; it reveals no content');
  return () => nostrCryptWith(identity, 'decrypt', 'nip44', seal.pubkey, seal.content);
}

test('the rumor of a tip wrap is refused, sealed claim key or not', () => {
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const claimKey = generateUrlFragmentKey().encoded;
  const shapes: TipPayload[] = [
    { type: 'tip', v: 1, asset: 'btc', amount: 5000, tipId: TIP_ID, sealedClaimKey: 'ab'.repeat(83) },
    // The pre-release wire shape, with the bearer key in the clear.
    { type: 'tip', v: 1, asset: 'btc', amount: 5000, tipId: TIP_ID, claimKey } as unknown as TipPayload,
  ];
  for (const payload of shapes) {
    const wrap = wrapPayment(alice, bob.pubkeyHex, payload);
    const rumor = openAsSite(bob, wrap);
    assert.throws(rumor, /Refusing to decrypt a Smirk tip/);
  }
});

test('an ordinary direct message still decrypts for the site', () => {
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const wrap = wrapDm(alice.privateKey, { publicKey: bob.pubkeyHex }, 'see you at the meetup');
  const rumor = JSON.parse(openAsSite(bob, wrap)()) as { kind: number; content: string };
  assert.equal(rumor.kind, 14);
  assert.equal(rumor.content, 'see you at the meetup');
});

test('a direct message that merely mentions a tip is not mistaken for one', () => {
  const alice = generateBurnerIdentity();
  const bob = generateBurnerIdentity();
  const text = JSON.stringify({ type: 'note', tipId: TIP_ID });
  const wrap = wrapDm(alice.privateKey, { publicKey: bob.pubkeyHex }, text);
  assert.equal((JSON.parse(openAsSite(bob, wrap)()) as { content: string }).content, text);
});
