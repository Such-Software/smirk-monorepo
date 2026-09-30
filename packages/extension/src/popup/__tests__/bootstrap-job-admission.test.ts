import './_chrome-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBootstrapInBackground, type BootstrapJobResult } from '../jobs/bootstrap-auth';
import type { JobsPortRequest, JobState } from '../../background/jobs/types';

test('first background completion keeps new-wallet evidence while completed-job replay retains authentication only', async (t) => {
  const fingerprint = crypto.randomUUID();
  const result: BootstrapJobResult = {
    accessToken: crypto.randomUUID(),
    bootstrap: { userId: 'test-user', isNew: true, restoreState: 'new', xmrStartHeight: 0 },
  };
  const state = {
    id: crypto.randomUUID(), kind: 'bootstrap-auth', status: 'done',
    dedupKey: `bootstrap-auth:${fingerprint}`, finishedAt: Date.now(), result,
  } as JobState<'bootstrap-auth'>;
  let completed = false;
  let startCalls = 0;
  let onMessage: (value: unknown) => void = () => {};
  let onDisconnect: () => void = () => {};
  const runtime = (chrome as unknown as { runtime?: unknown }).runtime;
  (chrome as unknown as { runtime: unknown }).runtime = {
    connect: () => ({
      onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
      onDisconnect: { addListener: (listener: typeof onDisconnect) => { onDisconnect = listener; } },
      postMessage: (request: JobsPortRequest) => queueMicrotask(() => {
        if (request.type === 'list') {
          onMessage({ type: 'ack', requestId: request.requestId, result: completed ? [state] : [] });
        } else if (request.type === 'start') {
          startCalls += 1;
          onMessage({ type: 'ack', requestId: request.requestId, result: state.id });
        } else {
          onMessage({ type: 'ack', requestId: request.requestId, result: {} });
          if (request.type === 'subscribe') {
            completed = true;
            onMessage({ type: 'event', subscriptionId: state.id, state });
          }
        }
      }),
    }),
  };
  t.after(() => {
    onDisconnect();
    (chrome as unknown as { runtime?: unknown }).runtime = runtime;
  });
  const input = { fingerprint, keys: [], signedTimestamp: 0, signature: crypto.randomUUID() };
  const first = await runBootstrapInBackground(input);
  assert.equal(first.bootstrap.restoreState, 'new');
  const callsAfterFirst = startCalls;
  const replay = await runBootstrapInBackground(input);
  assert.equal(replay.bootstrap.restoreState, undefined);
  assert.ok(replay.accessToken === result.accessToken);
  assert.equal(replay.bootstrap.xmrStartHeight, 0);
  assert.equal(startCalls, callsAfterFirst);
  assert.equal(first.bootstrap.restoreState, 'new');
});
