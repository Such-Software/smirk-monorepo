/**
 * On a backend without npub-native sign-in the popup hands the bootstrap to the
 * offscreen job, which holds no keys. The popup therefore makes the pre-v0.3
 * rotation proof itself, over the same timestamp as the login signature, and
 * only for a server that advertises the hardened legacy merge.
 *
 * Fixture: the standard BIP39 test vector phrase, never a real wallet.
 */

import './_chrome-stub';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  api,
  bitcoinMessageHash,
  bytesToHex,
  deriveAllKeys,
  deriveLegacyBtcLtcKey,
  mnemonicToSeed,
  rotationMessage,
} from '@smirk/core';
import type { UnlockedWallet } from '@smirk/core';

import { bootstrapAuthInExtension } from '../jobs/bootstrap-in-extension';
import type { JobsPortRequest, JobState } from '../../background/jobs/types';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Run the BTC bootstrap against a server advertising `features`; returns the job inputs. */
async function bootstrapAgainst(
  t: TestContext,
  features: Record<string, unknown>,
) {
  t.mock.method(api, 'getCapabilities', async () => ({ status: 200, data: { features } }) as never);

  const started: Array<Record<string, unknown>> = [];
  let onMessage: (value: unknown) => void = () => {};
  let onDisconnect: () => void = () => {};
  const runtime = (chrome as unknown as { runtime?: unknown }).runtime;
  (chrome as unknown as { runtime: unknown }).runtime = {
    connect: () => ({
      onMessage: { addListener: (l: typeof onMessage) => { onMessage = l; } },
      onDisconnect: { addListener: (l: typeof onDisconnect) => { onDisconnect = l; } },
      postMessage: (request: JobsPortRequest) => queueMicrotask(() => {
        if (request.type === 'list') {
          onMessage({ type: 'ack', requestId: request.requestId, result: [] });
        } else if (request.type === 'start') {
          started.push(request.input as Record<string, unknown>);
          onMessage({ type: 'ack', requestId: request.requestId, result: 'job-1' });
        } else {
          onMessage({ type: 'ack', requestId: request.requestId, result: {} });
          if (request.type === 'subscribe') {
            const state = {
              id: 'job-1', kind: 'bootstrap-auth', status: 'done', finishedAt: Date.now(),
              result: { accessToken: 'tok', bootstrap: { userId: 'user-1', isNew: false, restoreState: 'existing' } },
            } as JobState<'bootstrap-auth'>;
            onMessage({ type: 'event', subscriptionId: 'job-1', state });
          }
        }
      }),
    }),
  };
  t.after(() => {
    onDisconnect();
    (chrome as unknown as { runtime?: unknown }).runtime = runtime;
    api.setAccessToken(null);
  });

  const seed = mnemonicToSeed(PHRASE);
  const keys = deriveAllKeys(PHRASE, '', 3);
  const wallet = {
    fingerprint: `fp-${crypto.randomUUID()}`,
    mnemonic: PHRASE,
    seed,
    keys,
    addresses: { btc: 'x', ltc: 'x', xmr: 'x', wow: 'x', grin: 'x' },
  } as unknown as UnlockedWallet;

  const bootstrap = await bootstrapAuthInExtension(api, wallet);
  assert.equal(bootstrap.userId, 'user-1');
  assert.equal(started.length, 1);
  return { input: started[0]!, seed, keys };
}

test('the offscreen bootstrap receives a rotation proof made by the pre-v0.3 key', async (t) => {
  const { input, seed, keys } = await bootstrapAgainst(t, { legacy_merge_v2: true });
  const legacy = deriveLegacyBtcLtcKey(seed, 0);
  assert.equal(input.rotationPublicKey, bytesToHex(legacy.publicKey));
  const sig = Uint8Array.from(atob(String(input.rotationSignature)), (c) => c.charCodeAt(0));
  const digest = bitcoinMessageHash(
    rotationMessage(api.getBaseUrl(), bytesToHex(keys.btc.publicKey), Number(input.signedTimestamp)),
  );
  assert.ok(secp256k1.verify(sig.slice(1), digest, legacy.publicKey), 'signed by the m/44 key over the login timestamp');
});

// An older server lets a planted BTC key row fold into this account on the
// next unlock that carries a proof. Absent or false: sign in as v0.3.0 did.
for (const features of [{}, { legacy_merge_v2: false }]) {
  test(`a server advertising ${JSON.stringify(features)} gets no rotation proof`, async (t) => {
    const { input } = await bootstrapAgainst(t, features);
    assert.equal('rotationPublicKey' in input, false);
    assert.equal('rotationSignature' in input, false);
  });
}
