/**
 * Wire-format tests for `extensionRegister`.
 *
 * What's actually under test: the JSON.stringify body produced by
 * `createAuthMethods(...).extensionRegister(params)`. The Rust
 * backend's `ExtensionRegisterRequest` struct (in
 * `smirk-backend/src/api/auth.rs`) deserializes this; any
 * camel→snake mismatch or envelope-shape regression here lands as
 * an HTTP 422 in production — and we lived that on 2026-06-11 when
 * the SW bootstrap handler shipped a bare Solution instead of the
 * `{ challenge, solution }` envelope.
 *
 * Strategy: intercept `globalThis.fetch`, capture the request init
 * (URL + body), and assert against the captured body. Restores the
 * original fetch after each test so other tests aren't affected.
 *
 * Why not a higher-level integration test: lots of value for very
 * little setup. A snake_case typo is caught in <50ms by a unit
 * test; the same regression catches a full router integration test
 * 100× slower and with way more flake surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiClient } from '../api/client';
import { createAuthMethods } from '../api/auth';

interface CapturedRequest {
  url: string;
  method: string;
  bodyJson: Record<string, unknown>;
}

async function captureRegisterCall(
  call: (auth: ReturnType<typeof createAuthMethods>) => Promise<unknown>,
): Promise<CapturedRequest> {
  const originalFetch = globalThis.fetch;
  let captured: CapturedRequest | undefined;

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const bodyText =
      typeof init?.body === 'string' ? init.body : '';
    let bodyJson: Record<string, unknown> = {};
    if (bodyText) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        /* leave empty */
      }
    }
    captured = { url, method, bodyJson };
    // Return a believable success body so extensionRegister doesn't
    // throw on response parsing.
    return new Response(
      JSON.stringify({
        access_token: 'tok',
        refresh_token: 'rtok',
        expires_in: 86400,
        user: { id: 'u1', is_new: false },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ) as unknown as Response;
  }) as typeof globalThis.fetch;

  try {
    const client = new ApiClient('http://test.local/api/v1');
    const auth = createAuthMethods(client);
    await call(auth);
  } finally {
    globalThis.fetch = originalFetch;
  }

  if (!captured) {
    throw new Error('fetch was never called');
  }
  return captured;
}

const MINIMAL_REGISTER_PARAMS = {
  keys: [
    { asset: 'btc', publicKey: 'btc-pub-hex' },
    { asset: 'ltc', publicKey: 'ltc-pub-hex' },
    { asset: 'xmr', publicKey: 'xmr-spend-hex' },
    { asset: 'wow', publicKey: 'wow-spend-hex' },
    { asset: 'grin', publicKey: 'grin-pub-hex' },
  ],
  seedFingerprint: 'fp-deadbeef',
  signedTimestamp: 1_700_000_000,
  signature: 'sig-' + 'a'.repeat(128),
};

test('extensionRegister: posts to /auth/extension', async () => {
  const captured = await captureRegisterCall((auth) =>
    auth.extensionRegister(MINIMAL_REGISTER_PARAMS),
  );
  assert.equal(captured.method, 'POST');
  assert.equal(captured.url, 'http://test.local/api/v1/auth/extension');
});

test('extensionRegister: camelCase → snake_case mapping on every field', async () => {
  const captured = await captureRegisterCall((auth) =>
    auth.extensionRegister({
      ...MINIMAL_REGISTER_PARAMS,
      username: 'tester',
      walletBirthday: 1_650_000_000,
      xmrStartHeight: 3_400_000,
      wowStartHeight: 700_000,
    }),
  );
  const body = captured.bodyJson;
  // Snake-case keys exactly match the Rust ExtensionRegisterRequest
  // struct field names. Any rename here = 422 on the backend.
  assert.equal(body.seed_fingerprint, 'fp-deadbeef');
  assert.equal(body.signed_timestamp, 1_700_000_000);
  assert.equal(body.signature, MINIMAL_REGISTER_PARAMS.signature);
  assert.equal(body.username, 'tester');
  assert.equal(body.wallet_birthday, 1_650_000_000);
  assert.equal(body.xmr_start_height, 3_400_000);
  assert.equal(body.wow_start_height, 700_000);
});

test('extensionRegister: keys[].publicKey → keys[].public_key', async () => {
  const captured = await captureRegisterCall((auth) =>
    auth.extensionRegister(MINIMAL_REGISTER_PARAMS),
  );
  const keys = captured.bodyJson.keys as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(keys), true);
  assert.equal(keys.length, 5);
  for (const k of keys) {
    assert.ok(typeof k.public_key === 'string', 'public_key snake_case missing');
    assert.equal('publicKey' in k, false, 'publicKey should not leak through');
  }
  // Order must match the Rust handler expectations (BTC first).
  assert.equal(keys[0].asset, 'btc');
  assert.equal(keys[0].public_key, 'btc-pub-hex');
});

test('extensionRegister: altcha_solution envelope round-trips without flattening', async () => {
  // This is the 2026-06-11 regression test: a bare Solution must not
  // pass through unchanged; the typed AltchaPayload envelope MUST
  // arrive with `challenge` AND `solution` at the top level.
  // Shapes exactly match altcha-lib v2 + the Rust altcha::Payload:
  //   Challenge = { parameters: ChallengeParameters, signature?: string }
  //   Solution  = { counter: u32, derivedKey: string, time?: f64 }
  const altchaSolution = {
    challenge: {
      parameters: {
        algorithm: 'PBKDF2/SHA-256',
        cost: 100,
        keyLength: 32,
        keyPrefix: '00',
        nonce: 'nonce-hex',
        salt: 'salt-hex',
      },
      signature: 'server-hmac-signature',
    },
    solution: {
      counter: 42,
      derivedKey: 'deadbeef'.repeat(8),
      time: 137,
    },
  } as const;

  const captured = await captureRegisterCall((auth) =>
    auth.extensionRegister({
      ...MINIMAL_REGISTER_PARAMS,
      altchaSolution,
    }),
  );
  const sent = captured.bodyJson.altcha_solution as Record<string, unknown>;
  assert.ok(sent, 'altcha_solution must be present');
  assert.deepStrictEqual(
    Object.keys(sent).sort(),
    ['challenge', 'solution'],
    'altcha_solution must be the { challenge, solution } envelope',
  );
  const challengeField = sent.challenge as Record<string, unknown>;
  assert.ok(challengeField.parameters, 'envelope.challenge.parameters must be present');
  assert.equal(challengeField.signature, 'server-hmac-signature');
  const solutionField = sent.solution as Record<string, unknown>;
  assert.equal(solutionField.counter, 42);
  assert.equal(typeof solutionField.derivedKey, 'string');
});

test('extensionRegister: altcha_solution OMITTED when undefined (graceful-migration path)', async () => {
  const captured = await captureRegisterCall((auth) =>
    auth.extensionRegister(MINIMAL_REGISTER_PARAMS),
  );
  // JSON.stringify drops undefined values; backend treats absent
  // altcha_solution as 'no PoW supplied' which is fine while
  // POW_REQUIRED=false.
  assert.equal('altcha_solution' in captured.bodyJson, false);
});
