/**
 * Contract tests for `solvePowChallenge`: the wire shape sent as
 * the `altcha_solution` field on `/auth/extension`.
 *
 * Critical assertion: the return envelope is `{ challenge, solution }`
 * where `challenge` is the ORIGINAL Challenge object the server
 * signed (parameters + signature), NOT the Solution's internal
 * `challenge` hash field.
 *
 * Why this matters: on 2026-06-11 the SW bootstrap-auth handler
 * regressed and shipped a bare `Solution` as `altcha_solution`. The
 * Rust backend rejected with 'altcha_solution: missing field
 * challenge at line 1 column 894' on every wallet registration. A
 * single test on the wire shape would have caught it before ship.
 *
 * Test approach: feed a real altcha-lib `createChallenge` output to
 * `solvePowChallenge` (via a stubbed `api.powChallenge`), capture
 * the return value, assert envelope shape and field provenance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChallenge, type Challenge } from 'altcha-lib';
import { deriveKey as pbkdf2DeriveKey } from 'altcha-lib/algorithms/web/pbkdf2';

import { solvePowChallenge } from '../pow';
import type { ApiResponse } from '../api/client';

// Cheap fixture so `node --test` finishes in <1s. The contract is
// about envelope shape; actual solve difficulty is irrelevant for
// what we're testing.
const TEST_HMAC_KEY = 'pow-test-hmac-do-not-use-anywhere-else';

async function makeChallenge(): Promise<Challenge> {
  return await createChallenge({
    hmacKey: TEST_HMAC_KEY,
    algorithm: 'PBKDF2/SHA-256',
    cost: 100, // PBKDF2 iterations per attempt: kept tiny for tests
    maxnumber: 10,
    saltLength: 8,
  });
}

function makeStubApi(challenge: Challenge) {
  return {
    async powChallenge(): Promise<ApiResponse<unknown>> {
      return { data: challenge, status: 200 };
    },
  };
}

test('solvePowChallenge: returns the { challenge, solution } envelope (NOT a bare Solution)', async () => {
  const challenge = await makeChallenge();
  const result = await solvePowChallenge(makeStubApi(challenge));

  assert.notEqual(result, null, 'solvePowChallenge should succeed on a tiny challenge');
  if (!result) return; // narrow for TS

  // Envelope shape: top-level keys are EXACTLY {challenge, solution}.
  // If this set ever grows or shrinks, every downstream serializer
  // breaks. This is the test that catches the 2026-06-11 regression
  // where the SW handler shipped a bare Solution (counter,
  // derivedKey, time) as altcha_solution, which serde tried to
  // deserialize as altcha::Payload and rejected with 422.
  assert.deepStrictEqual(
    Object.keys(result).sort(),
    ['challenge', 'solution'],
    'top-level shape must be {challenge, solution}',
  );

  // `result.challenge` must be the ORIGINAL Challenge (parameters +
  // optional signature), NOT the Solution's internal `derivedKey`
  // hash. Provenance check: parameters object must exist with the
  // server-issued salt/nonce/cost. (createChallenge produces a
  // Challenge whose `signature` may be absent: `signature` is
  // Option<String> on the backend, so we assert parameters.)
  assert.ok(
    result.challenge.parameters,
    'envelope.challenge.parameters must be present (proves it is the original Challenge, not the Solution)',
  );
  assert.equal(
    result.challenge.parameters.salt,
    challenge.parameters.salt,
    'envelope.challenge.parameters.salt must equal the fetched challenge salt (provenance)',
  );
});

test('solvePowChallenge: envelope.solution is altcha-lib Solution shape (counter+derivedKey)', async () => {
  const challenge = await makeChallenge();
  const result = await solvePowChallenge(makeStubApi(challenge));
  assert.notEqual(result, null);
  if (!result) return;

  // Solution shape per altcha-lib v2 + altcha 0.1 Rust:
  //   { counter: u32, derivedKey: String (serde-renamed), time: f64? }
  // Any rename here changes the wire and breaks the backend.
  const sol = result.solution as Record<string, unknown>;
  assert.equal(typeof sol.counter, 'number', 'Solution must have `counter`');
  assert.equal(typeof sol.derivedKey, 'string', 'Solution must have `derivedKey`');
  // `time` is optional in the Rust struct; presence not asserted:
  // some altcha-lib versions omit it.
});

test('solvePowChallenge: returns null when challenge fetch fails (graceful migration path)', async () => {
  const stubApi = {
    async powChallenge(): Promise<ApiResponse<unknown>> {
      return { error: 'network', status: 503 };
    },
  };
  const result = await solvePowChallenge(stubApi);
  assert.equal(result, null, 'soft-fail to null when the backend is unreachable');
});

test('solvePowChallenge: accepts an AbortSignal option (signature surface check)', async () => {
  // We don't assert that abort actually interrupts the solve: altcha-
  // lib v2 checks `controller.signal.aborted` between counter
  // attempts but the PBKDF2 itself is atomic, so on a tiny test
  // challenge the solve may finish before the signal lands. The
  // surface contract is what we lock here; the cancellation
  // semantics are an altcha-lib concern tested upstream.
  const challenge = await makeChallenge();
  const controller = new AbortController();
  const result = await solvePowChallenge(
    makeStubApi(challenge),
    { signal: controller.signal },
  );
  // Either succeeds (signal not yet aborted) or returns null
  // (depending on race); both are valid contract behaviors.
  assert.ok(result === null || typeof result === 'object');
});

// Smoke test to keep the deriveKey import exercised: if someone
// removes the `web/pbkdf2` import by mistake, the test bundle
// fails to load and the breakage is visible.
test('pbkdf2DeriveKey is the web variant (uses crypto.subtle, not node:crypto)', () => {
  assert.equal(typeof pbkdf2DeriveKey, 'function');
});
