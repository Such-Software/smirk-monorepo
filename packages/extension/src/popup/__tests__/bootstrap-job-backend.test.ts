/**
 * A background sign-in's token is only presented to the backend that minted it.
 *
 * Reproduced 2026-10-11 against two local stub backends: switching to another
 * operator within four minutes of a sign-in replayed the previous operator's
 * completed job, so the new operator received the old one's bearer token on
 * every authenticated call. After "reset to the default backend" the opposite
 * happened: the default backend received a token the other operator minted.
 */
import './_chrome-stub';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapDedupKey, runBootstrapInBackground, type BootstrapJobResult } from '../jobs/bootstrap-auth';
import type { JobsPortRequest, JobState } from '../../background/jobs/types';

const A = { url: 'http://127.0.0.1:18701/api/v1', apiStyle: 'namespaced' as const };
const B = { url: 'http://127.0.0.1:18702/api/v1', apiStyle: 'namespaced' as const };

function signedIn(backendUrl: string): BootstrapJobResult {
  return {
    accessToken: crypto.randomUUID(),
    backendUrl,
    bootstrap: { userId: crypto.randomUUID(), isNew: false, restoreState: 'existing' },
  };
}

/**
 * Stand in for the service worker's jobs port. `listed` is what a `list`
 * returns; a `start` runs a job that finishes with `finish(input)`.
 */
function jobsPort(
  t: TestContext,
  listed: JobState[],
  finish: (input: Record<string, unknown>) => BootstrapJobResult,
) {
  const started: Array<{ input: Record<string, unknown>; dedupKey?: string }> = [];
  let pending: BootstrapJobResult | null = null;
  let onMessage: (value: unknown) => void = () => {};
  let onDisconnect: () => void = () => {};
  const runtime = (chrome as unknown as { runtime?: unknown }).runtime;
  (chrome as unknown as { runtime: unknown }).runtime = {
    connect: () => ({
      onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
      onDisconnect: { addListener: (listener: typeof onDisconnect) => { onDisconnect = listener; } },
      postMessage: (request: JobsPortRequest) => queueMicrotask(() => {
        if (request.type === 'list') {
          onMessage({ type: 'ack', requestId: request.requestId, result: listed });
          return;
        }
        if (request.type === 'start') {
          const input = request.input as Record<string, unknown>;
          started.push({ input, ...(request.dedupKey ? { dedupKey: request.dedupKey } : {}) });
          pending = finish(input);
          onMessage({ type: 'ack', requestId: request.requestId, result: 'job-started' });
          return;
        }
        onMessage({ type: 'ack', requestId: request.requestId, result: {} });
        if (request.type === 'subscribe' && pending) {
          const state = {
            id: request.id, kind: 'bootstrap-auth', status: 'done', finishedAt: Date.now(), result: pending,
          } as JobState<'bootstrap-auth'>;
          onMessage({ type: 'event', subscriptionId: request.id, state });
        }
      }),
    }),
  };
  t.after(() => {
    onDisconnect();
    (chrome as unknown as { runtime?: unknown }).runtime = runtime;
  });
  return started;
}

function inputFor(backend: typeof A, fingerprint: string) {
  return { backend, fingerprint, keys: [], signedTimestamp: 0, signature: crypto.randomUUID() };
}

test('a sign-in just completed at one backend is not replayed at another', async (t) => {
  const fingerprint = crypto.randomUUID();
  const atA = signedIn(A.url);
  const doneAtA = {
    id: 'job-at-a', kind: 'bootstrap-auth', status: 'done', finishedAt: Date.now(),
    dedupKey: bootstrapDedupKey(A.url, fingerprint), result: atA,
  } as JobState<'bootstrap-auth'>;
  let atB: BootstrapJobResult | null = null;
  const started = jobsPort(t, [doneAtA], () => (atB = signedIn(B.url)));

  const result = await runBootstrapInBackground(inputFor(B, fingerprint));

  assert.notEqual(result.accessToken, atA.accessToken, "the previous backend's token was handed to the new one");
  assert.equal(started.length, 1, 'no fresh sign-in ran at the new backend');
  assert.equal((started[0]!.input.backend as typeof B).url, B.url);
  assert.notEqual(started[0]!.dedupKey, doneAtA.dedupKey);
  assert.equal(result.accessToken, atB!.accessToken);
});

test('a sign-in at the same backend is still reused within the window', async (t) => {
  const fingerprint = crypto.randomUUID();
  const atA = signedIn(A.url);
  const doneAtA = {
    id: 'job-at-a', kind: 'bootstrap-auth', status: 'done', finishedAt: Date.now(),
    dedupKey: bootstrapDedupKey(A.url, fingerprint), result: atA,
  } as JobState<'bootstrap-auth'>;
  const started = jobsPort(t, [doneAtA], () => signedIn(A.url));

  const result = await runBootstrapInBackground(inputFor(A, fingerprint));

  assert.equal(result.accessToken, atA.accessToken);
  assert.equal(started.length, 0);
});

test('a token minted by a backend other than the one asked for is refused', async (t) => {
  const fingerprint = crypto.randomUUID();
  let minted: BootstrapJobResult | null = null;
  // The worker answered from the operator the user just left.
  jobsPort(t, [], () => (minted = signedIn(B.url)));

  await assert.rejects(runBootstrapInBackground(inputFor(A, fingerprint)), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.ok(e.message.includes(B.url) && e.message.includes(A.url), 'the refusal names both backends');
    assert.ok(!e.message.includes(minted!.accessToken), 'the refusal never repeats the token');
    return true;
  });
});
