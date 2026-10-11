/**
 * `bootstrapAuth` keeps its token only at the backend that minted it.
 *
 * Reproduced 2026-10-11: a sign-in still running when the window switched
 * backend installed the old backend's token on the re-pointed client, which
 * then presented it to the new operator on every authenticated call. The
 * sign-in now pins the backend it started on: it sends nothing more once the
 * client moves, and installs no token minted elsewhere.
 *
 * Fixture: the standard BIP39 test vector phrase, never a real wallet. Tokens
 * are random per test and never printed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapAuth } from '../wallet-flow';
import { SmirkApi, invalidateCapabilities, isBackendChangedError } from '../api';
import { deriveAllKeys, mnemonicToSeed } from '../hd';
import { deriveNostrIdentity } from '../nostr';
import type { UnlockedWallet } from '../keystore';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A = 'http://a.mock.test/api/v1';
const B = 'http://b.mock.test/api/v1';

function phraseWallet(): UnlockedWallet {
  return {
    fingerprint: 'fp-test-vector',
    seed: mnemonicToSeed(PHRASE),
    keys: deriveAllKeys(PHRASE, '', 3),
    addresses: { btc: 'x', ltc: 'x', xmr: 'x', wow: 'x', grin: 'x' },
  } as unknown as UnlockedWallet;
}

/**
 * A mock pair of backends. `onRequest` runs as each request arrives, before
 * the reply, so a test can re-point the client while that request is in
 * flight. Every request's URL is recorded.
 */
function withBackends(
  t: { after(fn: () => void): void },
  token: string,
  onRequest: (url: string) => void,
): string[] {
  invalidateCapabilities();
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    seen.push(url);
    onRequest(url);
    let body: unknown;
    if (url.endsWith('/capabilities')) {
      body = { features: {} };
    } else if (url.endsWith('/auth/check-restore')) {
      body = { exists: true, keys_valid: true };
    } else if (url.endsWith('/auth/extension')) {
      body = { access_token: token, refresh_token: 'r', expires_in: 60, is_new: false, user: { id: 'u' } };
    } else {
      throw new Error(`unexpected request in mock backend: ${url}`);
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return seen;
}

test('a token minted while the client moved to another backend is not installed', async (t) => {
  const api = new SmirkApi(A);
  api.setAccessToken(null);
  const minted = crypto.randomUUID();
  const seen = withBackends(t, minted, (url) => {
    // The user switches backend while the registration is in flight.
    if (url.endsWith('/auth/extension')) api.setBaseUrl(B);
  });

  await assert.rejects(bootstrapAuth(api, phraseWallet()), (e: unknown) => {
    assert.ok(isBackendChangedError(e), 'the refusal says the backend changed');
    assert.ok(!(e as Error).message.includes(minted), 'the refusal never repeats the token');
    return true;
  });
  assert.equal(api.getAccessToken(), null, "A's token was installed on a client pointed at B");
  assert.ok(seen.every((url) => url.startsWith(A)), 'a sign-in request reached the other backend');
});

test('a sign-in whose backend moves mid-way sends nothing further', async (t) => {
  const api = new SmirkApi(A);
  api.setAccessToken(null);
  const seen = withBackends(t, crypto.randomUUID(), (url) => {
    if (url.endsWith('/auth/check-restore')) api.setBaseUrl(B);
  });

  await assert.rejects(bootstrapAuth(api, phraseWallet()), isBackendChangedError);
  assert.equal(api.getAccessToken(), null);
  assert.ok(
    !seen.some((url) => url.endsWith('/auth/extension')),
    'the wallet registered after its backend moved',
  );
  assert.ok(seen.every((url) => url.startsWith(A)));
});

test('an npub registration whose backend moves after its challenge sends no body', async (t) => {
  const api = new SmirkApi(A);
  api.setAccessToken(null);
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith('/auth/nostr/register-challenge')) {
      // The window switches backend while the nonce is in flight.
      api.setBaseUrl(B);
      return new Response(JSON.stringify({ nonce: 'nonce-fixture' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected request in mock backend: ${url}`);
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const res = await api.nostrRegister({
    identity: deriveNostrIdentity(PHRASE, 0),
    keys: [{ asset: 'btc', publicKey: '02'.padEnd(66, 'a') }],
    seedFingerprint: 'fp-test-vector',
    inviteCode: 'invite-fixture',
    paymentInvoiceId: 'invoice-fixture',
  });

  assert.ok(res.error, 'the registration reported success after its backend moved');
  assert.deepEqual(
    seen.filter((url) => url.endsWith('/auth/nostr/register')),
    [],
    "the register body, with the old backend's invite and invoice, went to the new one",
  );
});

test('a sign-in that stays on its backend still installs its token', async (t) => {
  const api = new SmirkApi(A);
  api.setAccessToken(null);
  const minted = crypto.randomUUID();
  withBackends(t, minted, () => undefined);

  const result = await bootstrapAuth(api, phraseWallet());
  assert.equal(result.userId, 'u');
  assert.equal(api.getAccessToken(), minted);
  api.setAccessToken(null);
});
