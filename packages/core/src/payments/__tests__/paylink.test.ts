/**
 * GoblinPay pay-link parsing (P3): the frozen checkout URI a Magick Market listing
 * hands the wallet. Proves recipient decode (npub + nprofile), exact GRIN→nanogrin
 * conversion, proof-mode detection, and validation throws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { npubEncode, nprofileEncode } from 'nostr-tools/nip19';

import { generateBurnerIdentity } from '../../nostr/identity';
import { parseGoblinPayUri, grinToNanogrin, isGoblinPayUri } from '../paylink';

const merchant = generateBurnerIdentity();
const watcher = generateBurnerIdentity();
const npub = npubEncode(merchant.pubkeyHex);

test('grinToNanogrin converts decimals exactly (no float error)', () => {
  assert.equal(grinToNanogrin('1'), 1_000_000_000);
  assert.equal(grinToNanogrin('1.5'), 1_500_000_000);
  assert.equal(grinToNanogrin('0.000000001'), 1); // 1 nanogrin
  assert.equal(grinToNanogrin('12.345678901'.slice(0, 12)), 12_345_678_901);
  assert.throws(() => grinToNanogrin('1.2345678901')); // >9 fractional digits
  assert.throws(() => grinToNanogrin('abc'));
});

test('parses a full GoblinPay URI (npub recipient, proof mode, order, notify, count)', () => {
  const uri = `goblin:${npub}?amount=2.5&memo=coffee&proof=grin1merchantproofaddr&order=MM-deadbeef&notify=${npubEncode(watcher.pubkeyHex)}&count=3`;
  const r = parseGoblinPayUri(uri);
  assert.equal(r.scheme, 'goblin');
  assert.equal(r.recipientPubkeyHex, merchant.pubkeyHex);
  assert.equal(r.amountGrin, '2.5');
  assert.equal(r.amountNanogrin, 2_500_000_000);
  assert.equal(r.memo, 'coffee');
  assert.equal(r.proofAddress, 'grin1merchantproofaddr');
  assert.equal(r.proofMode, true);
  assert.equal(r.order, 'MM-deadbeef');
  assert.equal(r.notifyPubkeyHex, watcher.pubkeyHex);
  assert.equal(r.count, 3);
});

test('accepts the nostr: scheme and carries nprofile relay hints', () => {
  const nprofile = nprofileEncode({ pubkey: merchant.pubkeyHex, relays: ['wss://shop.example'] });
  const r = parseGoblinPayUri(`nostr:${nprofile}?amount=1`);
  assert.equal(r.scheme, 'nostr');
  assert.equal(r.recipientPubkeyHex, merchant.pubkeyHex);
  assert.deepEqual(r.recipientRelays, ['wss://shop.example']);
  assert.equal(r.amountNanogrin, 1_000_000_000);
});

test('no proof param ⇒ proofMode false; minimal URI (recipient only) is valid', () => {
  const r = parseGoblinPayUri(`goblin:${npub}`);
  assert.equal(r.proofMode, false);
  assert.equal(r.amountNanogrin, undefined);
  assert.equal(r.recipientPubkeyHex, merchant.pubkeyHex);
});

test('rejects bad scheme, bad recipient, and bad count', () => {
  assert.throws(() => parseGoblinPayUri('https://example.com?amount=1'), /scheme/);
  assert.throws(() => parseGoblinPayUri('goblin:notabech32?amount=1'));
  assert.throws(() => parseGoblinPayUri(`goblin:${npub}?count=0`), /count/);
  // A note (kind-1 nevent-style) is not a payable recipient.
  assert.throws(() => parseGoblinPayUri('goblin:nsec1abc'));
});

test('isGoblinPayUri routes only goblin:/nostr:', () => {
  assert.equal(isGoblinPayUri(`goblin:${npub}`), true);
  assert.equal(isGoblinPayUri('nostr:npub1x'), true);
  assert.equal(isGoblinPayUri('https://x'), false);
});
