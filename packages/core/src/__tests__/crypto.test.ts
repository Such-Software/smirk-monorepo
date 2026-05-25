/**
 * Crypto primitive tests.
 *
 * Focus on the bits that have failed in production before:
 * `signEd25519WithScalar` produces signatures verifiable by a
 * standard RFC-8032 ed25519 verifier, which is exactly what the
 * Smirk backend (and any downstream dapp's verifier) uses to
 * accept Smirk-platform challenge signatures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';

import { signEd25519WithScalar } from '../crypto';

// Two pinned scalars so the tests are deterministic across runs.
// Values are arbitrary fixed bytes — these scalars never get used
// for anything real.
const SCALAR_A = hexToBytes('0100000000000000000000000000000000000000000000000000000000000000');
const SCALAR_B = hexToBytes('d1da1ad8f04dfe72a0d2c2e7a5f6cb56bcc5d9437c8a55d6a82ec6f0a3915b04');

function publicKeyFor(scalar: Uint8Array): Uint8Array {
  // Match the call shape used by @smirk/core/hd for XMR/WOW/Grin
  // public-key derivation — the same call the wallet makes to
  // publish the public key the signature must verify against.
  return ed25519.ExtendedPoint.BASE.multiply(leBytesToBigInt(scalar)).toRawBytes();
}

test('signEd25519WithScalar: small-scalar signature verifies under standard ed25519', () => {
  const A = publicKeyFor(SCALAR_A);
  const msg = new TextEncoder().encode('smirk-auth-challenge-1234567890');
  const sig = signEd25519WithScalar(msg, SCALAR_A, A);
  assert.equal(sig.length, 64);
  // The whole point: a standard RFC-8032 verifier accepts our
  // custom-nonce signature, because the verification equation
  // `[s]G == R + [k]A` doesn't care how `r` was derived.
  assert.equal(ed25519.verify(sig, msg, A), true);
});

test('signEd25519WithScalar: mid-range-scalar signature verifies under standard ed25519', () => {
  const A = publicKeyFor(SCALAR_B);
  const msg = new TextEncoder().encode('smirk-auth-challenge-1234567890');
  const sig = signEd25519WithScalar(msg, SCALAR_B, A);
  assert.equal(sig.length, 64);
  assert.equal(ed25519.verify(sig, msg, A), true);
});

test('signEd25519WithScalar: different messages produce different signatures', () => {
  const A = publicKeyFor(SCALAR_A);
  const sigHello = signEd25519WithScalar(new TextEncoder().encode('hello'), SCALAR_A, A);
  const sigWorld = signEd25519WithScalar(new TextEncoder().encode('world'), SCALAR_A, A);
  assert.notEqual(bytesToHex(sigHello), bytesToHex(sigWorld));
});

test('signEd25519WithScalar: same (scalar, message) signs deterministically', () => {
  const A = publicKeyFor(SCALAR_A);
  const msg = new TextEncoder().encode('repeat-me');
  const a = signEd25519WithScalar(msg, SCALAR_A, A);
  const b = signEd25519WithScalar(msg, SCALAR_A, A);
  assert.equal(bytesToHex(a), bytesToHex(b));
});

test('signEd25519WithScalar: rejects malformed inputs', () => {
  const A = publicKeyFor(SCALAR_A);
  const msg = new TextEncoder().encode('m');
  assert.throws(() => signEd25519WithScalar(msg, new Uint8Array(31), A));
  assert.throws(() => signEd25519WithScalar(msg, SCALAR_A, new Uint8Array(31)));
});

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
function leBytesToBigInt(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    acc = (acc << 8n) | BigInt(bytes[i]!);
  }
  return acc;
}
