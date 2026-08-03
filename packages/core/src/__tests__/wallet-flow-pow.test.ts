/**
 * Behavioral tests for `bootstrapAuth`'s client-side PoW bypass.
 *
 * The bypass mirrors the backend's `is_returning_user` predicate in
 * `smirk-backend/src/api/auth.rs`: a re-registration for an
 * already-known pubkey_hash skips PoW verification on the server,
 * so spending CPU on a solution that will be ignored is pure waste.
 *
 * What's pinned here:
 *   1. New wallet (checkRestore.exists = false) → powSolver IS called
 *   2. Known wallet (checkRestore.exists = true) → powSolver is NOT
 *      called; extensionRegister body has no altchaSolution.
 *
 * The test injects a `powSolver` spy so we observe call/no-call
 * without running real PBKDF2. `extensionRegister` is intercepted
 * via globalThis.fetch (same approach as auth-wire.test.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapAuth } from '../wallet-flow';
import { SmirkApi } from '../api';
import type { AltchaPayload } from '../pow';
import type { UnlockedWallet } from '../keystore';

const FAKE_PAYLOAD: AltchaPayload = {
  // Shape matches altcha::Payload exactly; values are pinned-fake so
  // a `deepStrictEqual` round-trip is meaningful.
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
  solution: {
    counter: 1,
    derivedKey: 'aabb',
    time: 1,
  },
};

interface ServerScript {
  /** Reply to /auth/check-restore */
  checkRestoreExists: boolean;
  /** Capture sink for /auth/extension body */
  registerCalls: Array<Record<string, unknown>>;
  /** Capture sink for /auth/check-restore body */
  checkRestoreCalls: Array<Record<string, unknown>>;
}

function withMockBackend<T>(
  script: ServerScript,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const bodyJson: Record<string, unknown> = init?.body
      ? JSON.parse(init.body as string)
      : {};
    if (url.endsWith('/auth/check-restore')) {
      script.checkRestoreCalls.push(bodyJson);
      return new Response(
        JSON.stringify({
          exists: script.checkRestoreExists,
          xmr_start_height: script.checkRestoreExists ? 3_400_000 : undefined,
          wow_start_height: script.checkRestoreExists ? 700_000 : undefined,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as unknown as Response;
    }
    if (url.endsWith('/auth/extension')) {
      script.registerCalls.push(bodyJson);
      return new Response(
        JSON.stringify({
          access_token: 'tok',
          refresh_token: 'rtok',
          expires_in: 86400,
          user: { id: 'user-1', is_new: !script.checkRestoreExists },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as unknown as Response;
    }
    throw new Error(`Unexpected URL in mock backend: ${url}`);
  }) as typeof globalThis.fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

/**
 * Build a real-ish UnlockedWallet: bootstrapAuth needs real
 * BIP-32 keys to sign the timestamp. Using a deterministic mnemonic
 * keeps the test reproducible.
 */
function makeUnlockedWallet(): UnlockedWallet {
  // The actual seed bytes don't need to come from a real BIP-39
  // mnemonic for these tests: the bootstrap flow only uses
  // wallet.fingerprint, wallet.keys.btc.{privateKey,publicKey},
  // and the various asset public keys. Need exactly 32 bytes for
  // secp256k1 private keys (signBitcoinMessage validates).
  // Pick a fixed valid scalar (derived from the seed string hash)
  // so signing succeeds deterministically.
  const fakeBytes = (seed: string): Uint8Array => {
    const buf = new Uint8Array(32);
    const seedBytes = new TextEncoder().encode(seed);
    for (let i = 0; i < 32; i++) {
      // Mix-in pattern with a small offset so different seeds make
      // different keys but every byte is nonzero (zero scalar is
      // invalid for secp256k1).
      buf[i] = (seedBytes[i % seedBytes.length] ^ (i + 1)) || 1;
    }
    return buf;
  };
  return {
    fingerprint: 'fp-test-deterministic',
    keys: {
      btc: {
        privateKey: fakeBytes('btc-priv'),
        publicKey: fakeBytes('btc-pub'),
      },
      ltc: {
        privateKey: fakeBytes('ltc-priv'),
        publicKey: fakeBytes('ltc-pub'),
      },
      xmr: {
        privateSpendKey: fakeBytes('xmr-spend-priv'),
        publicSpendKey: fakeBytes('xmr-spend-pub'),
        privateViewKey: fakeBytes('xmr-view-priv'),
        publicViewKey: fakeBytes('xmr-view-pub'),
      },
      wow: {
        privateSpendKey: fakeBytes('wow-spend-priv'),
        publicSpendKey: fakeBytes('wow-spend-pub'),
        privateViewKey: fakeBytes('wow-view-priv'),
        publicViewKey: fakeBytes('wow-view-pub'),
      },
      grin: {
        privateKey: fakeBytes('grin-priv'),
        publicKey: fakeBytes('grin-pub'),
      },
    },
    addresses: {
      btc: 'fake-btc-addr',
      ltc: 'fake-ltc-addr',
      xmr: 'fake-xmr-addr',
      wow: 'fake-wow-addr',
      grin: 'fake-grin-addr',
    },
  } as unknown as UnlockedWallet;
}

test('bootstrapAuth: NEW wallet → powSolver IS called and altcha_solution rides in the request', async () => {
  const script: ServerScript = {
    checkRestoreExists: false,
    registerCalls: [],
    checkRestoreCalls: [],
  };
  const api = new SmirkApi('http://mock.test/api/v1');
  const wallet = makeUnlockedWallet();
  let solverCalls = 0;

  await withMockBackend(script, async () => {
    await bootstrapAuth(api, wallet, {
      powSolver: async () => {
        solverCalls++;
        return FAKE_PAYLOAD;
      },
    });
  });

  assert.equal(solverCalls, 1, 'new-wallet path MUST invoke the PoW solver');
  assert.equal(script.checkRestoreCalls.length, 1);
  assert.equal(script.registerCalls.length, 1);
  const body = script.registerCalls[0];
  assert.deepStrictEqual(
    (body.altcha_solution as Record<string, unknown>),
    FAKE_PAYLOAD,
    'altcha_solution must round-trip the solver output (envelope shape)',
  );
});

test('bootstrapAuth: RETURNING wallet → powSolver is NOT called (mirrors backend bypass)', async () => {
  const script: ServerScript = {
    checkRestoreExists: true,
    registerCalls: [],
    checkRestoreCalls: [],
  };
  const api = new SmirkApi('http://mock.test/api/v1');
  const wallet = makeUnlockedWallet();
  let solverCalls = 0;

  await withMockBackend(script, async () => {
    await bootstrapAuth(api, wallet, {
      powSolver: async () => {
        solverCalls++;
        return FAKE_PAYLOAD;
      },
    });
  });

  assert.equal(
    solverCalls,
    0,
    'returning-wallet path MUST skip the PoW solver — backend would ignore the solution anyway',
  );
  assert.equal(script.registerCalls.length, 1);
  const body = script.registerCalls[0];
  assert.equal(
    'altcha_solution' in body,
    false,
    'altcha_solution must be omitted from the request when no solve happened',
  );
});

test('bootstrapAuth: RETURNING wallet propagates xmr/wow start heights from checkRestore', async () => {
  // Regression guard: the bypass refactor must not accidentally
  // drop the resume-height optimization that imports rely on.
  const script: ServerScript = {
    checkRestoreExists: true,
    registerCalls: [],
    checkRestoreCalls: [],
  };
  const api = new SmirkApi('http://mock.test/api/v1');
  const wallet = makeUnlockedWallet();

  await withMockBackend(script, () =>
    bootstrapAuth(api, wallet, { powSolver: async () => FAKE_PAYLOAD }),
  );

  const body = script.registerCalls[0];
  assert.equal(body.xmr_start_height, 3_400_000);
  assert.equal(body.wow_start_height, 700_000);
  // walletBirthday is intentionally NOT sent for known wallets per
  // the comment in wallet-flow.ts: backend already has it.
  assert.equal(
    'wallet_birthday' in body,
    false,
    'walletBirthday must be omitted for known wallets',
  );
});
