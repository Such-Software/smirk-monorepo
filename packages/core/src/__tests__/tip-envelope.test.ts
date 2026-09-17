import test from 'node:test';
import assert from 'node:assert/strict';

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';

import {
  TIP_ASSET_ID,
  TIP_ASSET_SUITE,
  TIP_ENVELOPE_VERSION,
  TIP_TARGET_KEY_TYPE,
  TipSuite,
  isTipEnvelope,
  openAge,
  openSecp256k1,
  parseTipEnvelope,
  sealAge,
  sealSecp256k1,
  tipHeader,
  type AgeSealer,
} from '../tip-envelope';
import { generatePrivateKey, getPublicKey, randomBytes } from '../crypto';

const KEY_MATERIAL = new Uint8Array(32).fill(7);

test('secp256k1 suite round-trips and binds the header', () => {
  const priv = generatePrivateKey();
  const pub = getPublicKey(priv, true);
  const header = tipHeader('ltc');

  const sealed = sealSecp256k1(KEY_MATERIAL, pub, header);
  const env = parseTipEnvelope(sealed);
  assert.deepEqual(openSecp256k1(env, priv), KEY_MATERIAL);

  // Flipping the asset byte must fail the tag, not silently decrypt as another
  // asset: the header is associated data, so it cannot be edited in transit.
  const tampered = Uint8Array.from(sealed);
  tampered[2] = TIP_ASSET_ID.btc;
  assert.throws(() => openSecp256k1(parseTipEnvelope(tampered), priv));
});

test('the wrong recipient key cannot open an envelope', () => {
  const pub = getPublicKey(generatePrivateKey(), true);
  const sealed = sealSecp256k1(KEY_MATERIAL, pub, tipHeader('btc'));
  assert.throws(() => openSecp256k1(parseTipEnvelope(sealed), generatePrivateKey()));
});

test('each asset is targeted at a key of its own, never another coin key', () => {
  // The whole point of the change: no asset may be encrypted to btc's key
  // unless it IS btc. A regression here is the original bug returning.
  for (const asset of ['btc', 'ltc', 'xmr', 'wow', 'grin'] as const) {
    assert.equal(typeof TIP_ASSET_ID[asset], 'number');
    assert.equal(typeof TIP_ASSET_SUITE[asset], 'number');
    assert.ok(TIP_TARGET_KEY_TYPE[asset]);
  }
  // Asset bytes must be distinct, or the envelope stops being self-describing.
  const ids = Object.values(TIP_ASSET_ID);
  assert.equal(new Set(ids).size, ids.length);
  // The curve families are what pick the suite.
  assert.equal(TIP_ASSET_SUITE.btc, TIP_ASSET_SUITE.ltc);
  assert.equal(TIP_ASSET_SUITE.xmr, TIP_ASSET_SUITE.wow);
  assert.notEqual(TIP_ASSET_SUITE.grin, TIP_ASSET_SUITE.xmr);
  // Spend keys are not encryption targets.
  assert.equal(TIP_TARGET_KEY_TYPE.xmr, 'enc');
  assert.equal(TIP_TARGET_KEY_TYPE.wow, 'enc');
  assert.equal(TIP_TARGET_KEY_TYPE.grin, 'slatepack');
});

test('a legacy targeted payload is never mistaken for an envelope', () => {
  // Pre-envelope payloads open with a compressed secp256k1 point, so byte 0 is
  // 0x02 or 0x03. This is the property that lets both formats coexist with no
  // migration, so it is asserted over real keys rather than assumed.
  for (let i = 0; i < 32; i++) {
    const legacy = new Uint8Array(120);
    legacy.set(getPublicKey(generatePrivateKey(), true), 0);
    assert.ok(legacy[0] === 0x02 || legacy[0] === 0x03);
    assert.equal(isTipEnvelope(legacy), false);
  }
});

test('envelope version 0x02 and 0x03 stay burned', () => {
  // Reusing either would collide with a legacy payload's first byte.
  assert.equal(TIP_ENVELOPE_VERSION, 0x01);
  assert.notEqual(TIP_ENVELOPE_VERSION, 0x02);
  assert.notEqual(TIP_ENVELOPE_VERSION, 0x03);
});

test('an off-curve recipient key is refused rather than multiplied', () => {
  const bogus = new Uint8Array(33);
  bogus[0] = 0x02; // well-formed prefix, x is not on the curve
  assert.throws(() => sealSecp256k1(KEY_MATERIAL, bogus, tipHeader('btc')));
});

test('age suites carry the header outside the body and round-trip through it', () => {
  // A stand-in sealer: the real one is age-over-X25519 in wasm. What is under
  // test here is the envelope framing, not the cipher.
  const seed = randomBytes(32);
  const pub = new Uint8Array(32).fill(9);
  const age: AgeSealer = {
    seal: (payload) => Uint8Array.from([0xff, ...payload]),
    open: (body) => body.slice(1),
  };

  const header = tipHeader('grin');
  const sealed = sealAge(KEY_MATERIAL, pub, header, age);
  assert.deepEqual(sealed.slice(0, 3), header);
  assert.equal(sealed[1], TipSuite.AgeSlatepack);

  const env = parseTipEnvelope(sealed);
  assert.deepEqual(openAge(env, seed, age), KEY_MATERIAL);
});

test('parseTipEnvelope refuses anything that is not an envelope', () => {
  assert.throws(() => parseTipEnvelope(new Uint8Array([0x02, 1, 2, 3])));
  assert.throws(() => parseTipEnvelope(new Uint8Array([0x01])));
});
