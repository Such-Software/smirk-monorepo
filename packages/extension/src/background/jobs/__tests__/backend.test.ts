/**
 * The coordinator runs a job against the wallet's durable backend selection,
 * and a sign-in names that same backend or does not run. See ../backend.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { admitJobBackend } from '../backend';

const DEFAULT = { url: 'http://127.0.0.1:18701/api/v1', apiStyle: 'namespaced' as const };
const PREVIOUS = { url: 'http://127.0.0.1:18702/api/v1', apiStyle: 'namespaced' as const };

test('a sign-in for the selected backend runs against the selection', () => {
  const admitted = admitJobBackend('bootstrap-auth', { backend: DEFAULT }, DEFAULT);
  assert.deepEqual(admitted, DEFAULT);
});

test('a sign-in for a backend the wallet has left is refused, naming both', () => {
  assert.throws(
    () => admitJobBackend('bootstrap-auth', { backend: PREVIOUS }, DEFAULT),
    (e: unknown) => e instanceof Error && e.message.includes(PREVIOUS.url) && e.message.includes(DEFAULT.url),
  );
});

test('a sign-in that names no backend is refused rather than guessed', () => {
  for (const input of [{}, null, undefined, { backend: null }]) {
    assert.throws(
      () => admitJobBackend('bootstrap-auth', input, DEFAULT),
      (e: unknown) => e instanceof Error && e.message.includes(DEFAULT.url),
    );
  }
});
