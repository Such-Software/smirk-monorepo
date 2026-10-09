/**
 * Pre-v0.3 identity carry-over: the rotation proof a returning wallet sends so
 * the backend can move a `migrate-legacy` row (identity on the `m/44'` BTC key,
 * no key rows) onto the v0.3 `m/84'` key.
 *
 * Fixture: the standard BIP39 test vector phrase, never a real wallet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

import {
  bitcoinMessageHash,
  bytesToHex,
  deriveAllKeys,
  deriveLegacyBtcLtcKey,
  invalidateCapabilities,
  legacyBtcRotationProof,
  mergeLegacyIdentityAfterSignIn,
  mnemonicToSeed,
  ROTATION_PROOF_PREFIX,
  rotationMessage,
} from '../index';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const API = 'https://api.smirk.cash/api/v1';

/** A server's capabilities, as far as the merge gate reads them. */
function capsWith(legacyMergeV2: boolean | undefined) {
  invalidateCapabilities();
  return async () => ({
    data: { features: legacyMergeV2 === undefined ? {} : { legacy_merge_v2: legacyMergeV2 } } as never,
  });
}

test('rotation message matches the backend format byte for byte', () => {
  const newKey = '02' + '11'.repeat(32);
  const hash = bytesToHex(sha256(new TextEncoder().encode(newKey)));
  assert.equal(
    rotationMessage(`${API}/`, newKey, 1_790_000_000),
    `smirk-auth-rotate-v2|${API}|${hash}|1790000000`,
  );
});

test('no shipped wallet signs a rotation proof for a website', () => {
  // The shipped v0.3.0 dapp signer refuses exactly this pattern and nothing
  // else; the v1 proof (`smirk-rotate-v1|...`) slipped past it, so any site a
  // v0.3.0 user approved a signature for could obtain one.
  const SHIPPED_V030_REFUSAL = /^\s*smirk-auth-/i;
  const message = rotationMessage(API, '02' + '22'.repeat(32), 1_790_000_000);
  assert.match(message, SHIPPED_V030_REFUSAL);
  assert.ok(message.startsWith(ROTATION_PROOF_PREFIX));
  assert.doesNotMatch(message, /smirk-rotate-v1/);
  // Never the login message (`smirk-auth-` and an integer).
  assert.doesNotMatch(message, /^smirk-auth-\d+$/);
});

test('the proof is made by the pre-v0.3 m/44 key and verifies under it', () => {
  const seed = mnemonicToSeed(PHRASE);
  const v3 = deriveAllKeys(PHRASE, '', 3);
  const newKey = bytesToHex(v3.btc.publicKey);
  const legacy = deriveLegacyBtcLtcKey(seed, 0);
  const ts = 1_790_000_000;

  const proof = legacyBtcRotationProof(seed, newKey, ts, API);
  assert.ok(proof, 'v0.3 and pre-v0.3 BTC keys differ, so a proof is produced');
  assert.equal(proof.rotationPublicKey, bytesToHex(legacy.publicKey));
  assert.notEqual(proof.rotationPublicKey, newKey);

  const sig = Uint8Array.from(atob(proof.rotationSignature), (c) => c.charCodeAt(0));
  assert.equal(sig.length, 65);
  const digest = bitcoinMessageHash(rotationMessage(API, newKey, ts));
  assert.ok(
    secp256k1.verify(sig.slice(1), digest, legacy.publicKey),
    'signature verifies under the legacy key',
  );
  assert.ok(
    !secp256k1.verify(sig.slice(1), digest, v3.btc.publicKey),
    'and not under the v0.3 key',
  );
});

test('no proof when the old and new keys coincide', () => {
  const seed = mnemonicToSeed(PHRASE);
  const legacyHex = bytesToHex(deriveLegacyBtcLtcKey(seed, 0).publicKey);
  assert.equal(legacyBtcRotationProof(seed, legacyHex, 1, API), null);
});

test('after an npub sign-in, the merge request carries a proof for the v0.3 key', async () => {
  const seed = mnemonicToSeed(PHRASE);
  const v3 = deriveAllKeys(PHRASE, '', 3);
  const sent: Array<Record<string, unknown>> = [];
  const api = {
    getBaseUrl: () => API,
    getCapabilities: capsWith(true),
    legacyMerge: async (params: Record<string, unknown>) => {
      sent.push(params);
      return { data: { outcome: 'merged' } };
    },
  };
  const outcome = await mergeLegacyIdentityAfterSignIn(api as never, { seed, keys: v3 });
  assert.equal(outcome, 'merged');
  assert.equal(sent.length, 1);
  const req = sent[0]!;
  assert.equal(req.btcPublicKey, bytesToHex(v3.btc.publicKey));
  assert.equal(req.previousPublicKey, bytesToHex(deriveLegacyBtcLtcKey(seed, 0).publicKey));
  const sig = Uint8Array.from(atob(String(req.rotationSignature)), (c) => c.charCodeAt(0));
  const digest = bitcoinMessageHash(
    rotationMessage(API, String(req.btcPublicKey), Number(req.signedTimestamp)),
  );
  assert.ok(secp256k1.verify(sig.slice(1), digest, deriveLegacyBtcLtcKey(seed, 0).publicKey));
});

test('no seed means no merge request, and a failure never throws', async () => {
  const v3 = deriveAllKeys(PHRASE, '', 3);
  let calls = 0;
  const api = {
    getBaseUrl: () => API,
    getCapabilities: capsWith(true),
    legacyMerge: async () => {
      calls += 1;
      throw new Error('offline');
    },
  };
  assert.equal(await mergeLegacyIdentityAfterSignIn(api as never, { keys: v3 }), 'skipped');
  assert.equal(calls, 0);
  assert.equal(
    await mergeLegacyIdentityAfterSignIn(api as never, { seed: mnemonicToSeed(PHRASE), keys: v3 }),
    'failed',
  );
  assert.equal(calls, 1);
});

test('a server that does not advertise the hardened merge is never sent a merge request', async () => {
  // An older server (smirk-backend-core 45b0143 and before) folds any
  // unanchored row whose BTC key row is the old key, and any session can plant
  // that row; it also takes a v0.3 row for a legacy one. Absent, false, or an
  // unreadable /capabilities all mean: do not ask.
  const seed = mnemonicToSeed(PHRASE);
  const v3 = deriveAllKeys(PHRASE, '', 3);
  const unreadable = async () => {
    invalidateCapabilities();
    throw new Error('offline');
  };
  for (const getCapabilities of [capsWith(undefined), capsWith(false), unreadable]) {
    let calls = 0;
    const api = {
      getBaseUrl: () => API,
      getCapabilities,
      legacyMerge: async () => {
        calls += 1;
        return { data: { outcome: 'merged' } };
      },
    };
    assert.equal(await mergeLegacyIdentityAfterSignIn(api as never, { seed, keys: v3 }), 'skipped');
    assert.equal(calls, 0);
  }
});
