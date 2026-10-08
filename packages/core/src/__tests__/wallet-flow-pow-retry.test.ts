/**
 * `bootstrapAuth` when the backend refuses the known-wallet fast path.
 *
 * The client skips the PoW solve for a seed fingerprint `checkRestore` knows,
 * but smirk-backend-core waives PoW only for a BTC `pubkey_hash` already on
 * file. A pre-v0.3 (`migrate-legacy`) wallet is known by fingerprint under its
 * old `m/44'` key, so `/auth/extension` refuses the unsolved request, and its
 * rotation branch enforces PoW as well. These tests emulate that backend and pin
 * the answer: solve once, then resend with the same keys, a fresh login
 * signature and a fresh rotation proof.
 *
 * Fixture: the standard BIP39 test vector phrase, never a real wallet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';

import { bootstrapAuth } from '../wallet-flow';
import { SmirkApi } from '../api';
import { isPowRequiredRejection, type AltchaPayload } from '../pow';
import { bitcoinMessageHash, bytesToHex } from '../crypto';
import { deriveAllKeys, deriveLegacyBtcLtcKey, mnemonicToSeed } from '../hd';
import { rotationMessage } from '../legacy-rotation';
import type { UnlockedWallet } from '../keystore';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const API = 'http://mock.test/api/v1';
const START_MS = 1_790_000_000_000;
/** How far the clock moves while the first request is in flight. */
const FLIGHT_MS = 7_000;

/** The refusal smirk-backend-core 0fa9a11e sends from `enforce_pow`. */
const LEGACY_POW_REFUSAL = {
  status: 400,
  body: {
    error:
      'Proof-of-work solution is required to create a new wallet. Please upgrade to a newer Smirk client.',
    code: 'VALIDATION_ERROR',
  },
};

const FAKE_PAYLOAD: AltchaPayload = {
  challenge: {
    parameters: {
      algorithm: 'PBKDF2/SHA-256',
      cost: 1,
      keyLength: 32,
      keyPrefix: '00',
      nonce: 'test-nonce',
      salt: 'test-salt',
    },
    signature: 'test-server-sig',
  },
  solution: { counter: 1, derivedKey: 'aabb', time: 1 },
};

const SIGNED_IN = {
  status: 200,
  body: { access_token: 'tok', refresh_token: 'rtok', expires_in: 86400, is_new: false, user: { id: 'user-1' } },
};

function phraseWallet(): UnlockedWallet {
  return {
    fingerprint: 'fp-test-vector',
    seed: mnemonicToSeed(PHRASE),
    keys: deriveAllKeys(PHRASE, '', 3),
    addresses: { btc: 'x', ltc: 'x', xmr: 'x', wow: 'x', grin: 'x' },
  } as unknown as UnlockedWallet;
}

type Reply = { status: number; body: unknown };

/**
 * Mock backend: check-restore reports `exists`, and `/auth/extension` answers
 * from `onRegister`, which sees each request body. The clock advances
 * `FLIGHT_MS` while the first registration is in flight, so a resend that
 * reused the first signature would carry a stale timestamp.
 */
async function withBackend<T>(
  t: { mock: { timers: { enable(o: unknown): void; tick(ms: number): void; reset(): void } } },
  exists: boolean,
  onRegister: (body: Record<string, unknown>, index: number) => Reply,
  run: (calls: Array<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  t.mock.timers.enable({ apis: ['Date'], now: START_MS });
  const calls: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    let reply: Reply;
    if (url.endsWith('/auth/check-restore')) {
      reply = {
        status: 200,
        body: { exists, keys_valid: exists ? true : null, xmr_start_height: exists ? 3_400_000 : undefined },
      };
    } else if (url.endsWith('/auth/extension')) {
      calls.push(body);
      reply = onRegister(body, calls.length - 1);
      if (calls.length === 1) t.mock.timers.tick(FLIGHT_MS);
    } else {
      throw new Error(`Unexpected URL in mock backend: ${url}`);
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
    t.mock.timers.reset();
  }
}

function verifiesUnder(message: string, signatureB64: unknown, publicKey: Uint8Array): boolean {
  const sig = Uint8Array.from(atob(String(signatureB64)), (c) => c.charCodeAt(0));
  return secp256k1.verify(sig.slice(1), bitcoinMessageHash(message), publicKey);
}

test('a known pre-v0.3 wallet refused for want of PoW solves once and resends, re-signed, with its rotation proof', async (t) => {
  const wallet = phraseWallet();
  const newKeyHex = bytesToHex(wallet.keys.btc.publicKey);
  const legacy = deriveLegacyBtcLtcKey(mnemonicToSeed(PHRASE), 0);
  const api = new SmirkApi(API);
  let solves = 0;

  await withBackend(
    t,
    true,
    // auth.rs rotation branch: a valid proof, but PoW is still enforced.
    (body) => (body.altcha_solution ? SIGNED_IN : LEGACY_POW_REFUSAL),
    async (calls) => {
      const result = await bootstrapAuth(api, wallet, {
        powSolver: async () => {
          solves += 1;
          return FAKE_PAYLOAD;
        },
      });
      assert.equal(result.userId, 'user-1');
      assert.equal(result.isNew, false);
      assert.equal(result.restoreState, 'existing');
      assert.equal(api.getAccessToken(), 'tok');

      assert.equal(solves, 1, 'one solve, only after the refusal');
      assert.equal(calls.length, 2, 'the refused request is resent once');
      const [first, second] = calls as [Record<string, unknown>, Record<string, unknown>];
      assert.equal('altcha_solution' in first, false, 'the fast path sends no solution');
      assert.deepStrictEqual(second.altcha_solution, FAKE_PAYLOAD);
      assert.deepStrictEqual(second.keys, first.keys, 'same keys');
      assert.equal(second.seed_fingerprint, first.seed_fingerprint);

      const ts = Number(second.signed_timestamp);
      assert.ok(ts >= Number(first.signed_timestamp) + FLIGHT_MS / 1000, 'a fresh timestamp');
      assert.ok(
        verifiesUnder(`smirk-auth-${ts}`, second.signature, wallet.keys.btc.publicKey),
        'the login signature is made for the resend',
      );

      for (const body of [first, second]) {
        assert.equal(body.rotation_public_key, bytesToHex(legacy.publicKey), 'both carry the m/44 key');
      }
      assert.ok(
        verifiesUnder(rotationMessage(API, newKeyHex, ts), second.rotation_signature, legacy.publicKey),
        'the rotation proof binds the resend timestamp',
      );
    },
  );
});

test('the stable POW_REQUIRED code triggers the same resend, whatever the message', async (t) => {
  const api = new SmirkApi(API);
  let solves = 0;
  await withBackend(
    t,
    true,
    (body) =>
      body.altcha_solution
        ? SIGNED_IN
        : { status: 400, body: { error: 'Solve the challenge first.', code: 'POW_REQUIRED' } },
    async (calls) => {
      await bootstrapAuth(api, phraseWallet(), {
        powSolver: async () => {
          solves += 1;
          return FAKE_PAYLOAD;
        },
      });
      assert.equal(solves, 1);
      assert.equal(calls.length, 2);
    },
  );
});

test('a refusal that is not about a missing solution is neither solved nor resent', async (t) => {
  const api = new SmirkApi(API);
  let solves = 0;
  await withBackend(
    t,
    true,
    () => ({ status: 401, body: { error: 'Invalid signature', code: 'AUTH_ERROR' } }),
    async (calls) => {
      await assert.rejects(
        bootstrapAuth(api, phraseWallet(), {
          powSolver: async () => {
            solves += 1;
            return FAKE_PAYLOAD;
          },
        }),
        /Invalid signature/,
      );
      assert.equal(solves, 0);
      assert.equal(calls.length, 1);
    },
  );
});

test('a rejected solution is not resent', async (t) => {
  const api = new SmirkApi(API);
  let solves = 0;
  await withBackend(
    t,
    false,
    () => ({ status: 400, body: { error: 'PoW solution rejected (wrong solution)', code: 'VALIDATION_ERROR' } }),
    async (calls) => {
      await assert.rejects(
        bootstrapAuth(api, phraseWallet(), {
          powSolver: async () => {
            solves += 1;
            return FAKE_PAYLOAD;
          },
        }),
        /rejected/,
      );
      assert.equal(solves, 1, 'only the new-wallet solve');
      assert.equal(calls.length, 1);
    },
  );
});

test('a resend whose solve fails stops with a retryable error, not the upgrade advice', async (t) => {
  const api = new SmirkApi(API);
  await withBackend(
    t,
    true,
    () => LEGACY_POW_REFUSAL,
    async (calls) => {
      await assert.rejects(
        bootstrapAuth(api, phraseWallet(), { powSolver: async () => null }),
        (e: unknown) => e instanceof Error && /proof-of-work/i.test(e.message) && !/upgrade|update|newer|latest/i.test(e.message),
      );
      assert.equal(calls.length, 1, 'nothing is resent without a solution');
    },
  );
});

test('isPowRequiredRejection matches a missing solution only', () => {
  assert.ok(isPowRequiredRejection({ code: 'POW_REQUIRED' }));
  assert.ok(isPowRequiredRejection({ status: 400, code: 'POW_REQUIRED', error: 'anything' }));
  assert.ok(isPowRequiredRejection({ status: 400, error: LEGACY_POW_REFUSAL.body.error }));
  assert.ok(!isPowRequiredRejection({ status: 422, error: LEGACY_POW_REFUSAL.body.error }));
  assert.ok(!isPowRequiredRejection({ status: 400, error: 'PoW solution rejected (wrong solution)' }));
  assert.ok(!isPowRequiredRejection({ status: 409, error: 'This wallet already has an account.' }));
  assert.ok(!isPowRequiredRejection({ error: 'Request timed out' }));
});
