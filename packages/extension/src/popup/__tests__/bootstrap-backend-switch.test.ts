/**
 * A popup sign-in keeps its token, its invoice and its bookkeeping at the
 * backend it started on.
 *
 * Review of #46, reproduced with a probe: a background sign-in still running
 * when the window switched backend (Settings, or another window's reset) came
 * back and installed the old backend's token on the newly pointed client, and
 * the next request to the new backend carried it as a bearer. The npub path
 * installed its token after its awaits the same way. And a pay-to-register
 * invoice pending at one backend was attached to the next sign-in anywhere.
 *
 * Fixture: the standard BIP39 test vector phrase, never a real wallet. Tokens
 * and invoice ids are random per test and never printed.
 */
import './_chrome-stub';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import {
  api,
  applyBackendConfig,
  deriveAllKeys,
  invalidateCapabilities,
  isBackendChangedError,
  mnemonicToSeed,
  type UnlockedWallet,
} from '@smirk/core';
import { bootstrapAuthInExtension } from '../jobs/bootstrap-in-extension';
import {
  clearPendingRegistrationInvoice,
  getPendingRegistrationInvoice,
  setPendingRegistrationInvoice,
} from '../pending-registration-invoice';
import { rememberedBackendAccounts } from '../../backend-accounts';
import type { JobsPortRequest, JobState } from '../../background/jobs/types';

const A = { url: 'http://127.0.0.1:18701/api/v1', apiStyle: 'namespaced' as const };
const B = { url: 'http://127.0.0.1:18702/api/v1', apiStyle: 'namespaced' as const };
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function phraseWallet(): UnlockedWallet {
  return {
    fingerprint: `fp-${crypto.randomUUID()}`,
    mnemonic: PHRASE,
    seed: mnemonicToSeed(PHRASE),
    keys: deriveAllKeys(PHRASE, '', 3),
    addresses: { btc: 'x', ltc: 'x', xmr: 'x', wow: 'x', grin: 'x' },
  } as unknown as UnlockedWallet;
}

/** Point the client at `backend` with no session, restoring both afterwards. */
function startAt(t: TestContext, backend: typeof A): void {
  const previous = { url: api.getBaseUrl(), apiStyle: api.getWalletApiStyle() };
  applyBackendConfig(backend);
  invalidateCapabilities();
  t.after(() => {
    applyBackendConfig(previous);
    invalidateCapabilities();
  });
}

/**
 * Answer every HTTP request: capabilities as a legacy (BTC-path) backend unless
 * `features` says otherwise. Records each request's URL and bearer.
 */
function httpBackends(t: TestContext, features: Record<string, unknown> = {}) {
  const seen: Array<{ url: string; bearer: string | null }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '';
    seen.push({ url, bearer: auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null });
    const body = url.endsWith('/capabilities') ? { features, chains: {} } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return seen;
}

/**
 * Stand in for the service worker's jobs port. A started sign-in finishes, at
 * the backend it named, only when the test calls `finish()`.
 */
function jobsPort(t: TestContext) {
  const started: Array<Record<string, unknown>> = [];
  let token = '';
  let finish: () => void = () => {
    throw new Error('no sign-in has started');
  };
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
          return;
        }
        if (request.type === 'start') {
          started.push(request.input as Record<string, unknown>);
          onMessage({ type: 'ack', requestId: request.requestId, result: `job-${started.length}` });
          return;
        }
        onMessage({ type: 'ack', requestId: request.requestId, result: {} });
        if (request.type === 'subscribe') {
          const input = started.at(-1)!;
          finish = () => {
            token = crypto.randomUUID();
            const state = {
              id: request.id, kind: 'bootstrap-auth', status: 'done', finishedAt: Date.now(),
              result: {
                accessToken: token,
                backendUrl: (input.backend as typeof A).url,
                bootstrap: { userId: 'u', isNew: false, restoreState: 'existing' },
              },
            } as JobState<'bootstrap-auth'>;
            onMessage({ type: 'event', subscriptionId: request.id, state });
          };
        }
      }),
    }),
  };
  t.after(() => {
    onDisconnect();
    (chrome as unknown as { runtime?: unknown }).runtime = runtime;
  });
  return {
    started,
    token: () => token,
    finish: () => finish(),
    async whenStarted(): Promise<void> {
      for (let i = 0; i < 200 && started.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(started.length > 0, 'the sign-in never started its background job');
    },
  };
}

test('a background sign-in that finishes after a switch installs no token', async (t) => {
  startAt(t, A);
  const seen = httpBackends(t);
  const port = jobsPort(t);

  const signingIn = bootstrapAuthInExtension(api, phraseWallet());
  await port.whenStarted();
  assert.equal((port.started[0]!.backend as typeof A).url, A.url);

  // The user switches to B (Settings, or another window's reset) mid-sign-in.
  applyBackendConfig(B);
  port.finish();
  await assert.rejects(signingIn, (e: unknown) => {
    assert.ok(isBackendChangedError(e), 'the refusal says the backend changed');
    assert.ok(!(e as Error).message.includes(port.token()), 'the refusal never repeats the token');
    return true;
  });

  assert.equal(api.getBaseUrl(), B.url);
  assert.equal(api.getAccessToken(), null, "A's token was installed on the client pointed at B");
  seen.length = 0;
  await api.getCapabilities();
  assert.ok(seen.length > 0);
  assert.ok(seen.every((r) => r.bearer !== port.token()), "B was sent A's bearer token");
});

test('an npub sign-in that finishes after a switch installs no token', async (t) => {
  startAt(t, A);
  httpBackends(t);
  const minted = crypto.randomUUID();
  t.mock.method(api, 'getCapabilities', async () => ({
    status: 200,
    data: { features: { nostr_native_auth: true } },
  }));
  t.mock.method(api, 'checkRestore', async () => ({
    status: 200,
    data: { exists: true, keysValid: true },
  }));
  t.mock.method(api, 'nostrRegister', async () => {
    // The switch lands while the registration is in flight.
    applyBackendConfig(B);
    return {
      status: 200,
      data: { accessToken: minted, refreshToken: 'r', expiresIn: 60, isNew: false, user: { id: 'u' } },
    };
  });

  await assert.rejects(bootstrapAuthInExtension(api, phraseWallet()), isBackendChangedError);
  assert.equal(api.getBaseUrl(), B.url);
  assert.equal(api.getAccessToken(), null, "A's token was installed on the client pointed at B");
});

test("a pay-to-register invoice pending at one backend is not sent to another", async (t) => {
  startAt(t, A);
  httpBackends(t);
  const port = jobsPort(t);
  const wallet = phraseWallet();
  const invoiceAtB = crypto.randomUUID();
  await setPendingRegistrationInvoice(wallet.fingerprint, B.url, invoiceAtB);
  t.after(() => clearPendingRegistrationInvoice(wallet.fingerprint, B.url));

  const signingIn = bootstrapAuthInExtension(api, wallet);
  await port.whenStarted();
  port.finish();
  await signingIn;

  assert.equal(
    'paymentInvoiceId' in port.started[0]!,
    false,
    "B's invoice was attached to a sign-in at A",
  );
  assert.equal(
    await getPendingRegistrationInvoice(wallet.fingerprint, B.url),
    invoiceAtB,
    "a sign-in at A spent B's pending record",
  );
});

test('a pay-to-register invoice is still resumed at the backend that minted it', async (t) => {
  startAt(t, B);
  httpBackends(t);
  const port = jobsPort(t);
  const wallet = phraseWallet();
  const invoiceAtB = crypto.randomUUID();
  await setPendingRegistrationInvoice(wallet.fingerprint, B.url, invoiceAtB);

  const signingIn = bootstrapAuthInExtension(api, wallet);
  await port.whenStarted();
  assert.equal(port.started[0]!.paymentInvoiceId, invoiceAtB);
  port.finish();
  await signingIn;
  assert.equal(await getPendingRegistrationInvoice(wallet.fingerprint, B.url), null, 'the spent record survived');
});

test('a backend the wallet signs in at is remembered for the dapp signing guard', async (t) => {
  startAt(t, A);
  httpBackends(t);
  const port = jobsPort(t);

  const signingIn = bootstrapAuthInExtension(api, phraseWallet());
  await port.whenStarted();
  port.finish();
  await signingIn;
  assert.ok((await rememberedBackendAccounts()).includes(A.url));
});
