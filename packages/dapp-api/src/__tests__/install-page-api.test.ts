/**
 * Sender authentication for the page-side postMessage transport that
 * `installSmirkPageApi()` installs in iframe mode.
 *
 * This SDK ships to third-party dapp pages, so every other frame on such a
 * page (an ad frame, an embedded widget) shares the page's message bus and can
 * see the channel discriminator. None of them may answer a pending wallet
 * request: only the frame we posted the request TO (the wallet shell, i.e. our
 * parent) counts, and when the dapp pins the wallet's origin, only that origin.
 *
 * No jsdom (same posture as page-api-script.test.ts): a hand-rolled `window`
 * on `globalThis` covers everything the runtime touches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_POSTMESSAGE_CHANNEL,
  installSmirkPageApi,
} from '../install-page-api';
import { PROTOCOL_VERSION } from '../protocol';

interface DeliveredEvent {
  data: unknown;
  source: unknown;
  origin: string;
}

type MessageListener = (ev: DeliveredEvent) => void;

interface PostedMessage {
  message: { channel?: string; payload?: { id?: number } };
  targetOrigin: string;
}

interface FakeEnv {
  win: Record<string, unknown>;
  /** Stands in for the wallet shell frame: the only legitimate responder. */
  parent: object;
  posted: PostedMessage[];
  deliver: (ev: DeliveredEvent) => void;
}

function makeEnv(): FakeEnv {
  const posted: PostedMessage[] = [];
  const listeners: MessageListener[] = [];
  const parent = {
    postMessage: (message: unknown, targetOrigin: string) => {
      posted.push({
        message: message as PostedMessage['message'],
        targetOrigin,
      });
    },
  };
  const win: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, fn: MessageListener) => {
      if (type === 'message') listeners.push(fn);
    },
    dispatchEvent: () => true,
    location: { origin: 'https://dapp.example' },
  };
  return {
    win,
    parent,
    posted,
    deliver: (ev) => {
      for (const fn of [...listeners]) fn(ev);
    },
  };
}

const g = globalThis as unknown as Record<string, unknown>;

function installWindow(env: FakeEnv): void {
  g['window'] = env.win;
  // The runtime dispatches a `smirk-ready` CustomEvent on install. Node 20 has
  // the global, but keep the test independent of that.
  if (typeof g['CustomEvent'] === 'undefined') {
    g['CustomEvent'] = class FakeCustomEvent {
      readonly type: string;
      constructor(type: string) {
        this.type = type;
      }
    };
  }
}

function connect(env: FakeEnv): Promise<unknown> {
  const api = env.win['smirk'] as {
    connect: (assets?: string[]) => Promise<unknown>;
  };
  return api.connect(['btc']);
}

/** Id the runtime allocated for the single in-flight request. */
function pendingId(env: FakeEnv): number {
  const first = env.posted[0];
  assert.ok(first, 'expected a SMIRK_REQUEST to have been posted');
  const id = first.message.payload?.id;
  assert.equal(typeof id, 'number');
  return id as number;
}

function responseFor(id: number, result: unknown): unknown {
  return {
    channel: DEFAULT_POSTMESSAGE_CHANNEL,
    payload: {
      type: 'SMIRK_RESPONSE',
      v: PROTOCOL_VERSION,
      id,
      result,
    },
  };
}

function isTimeout(e: unknown): boolean {
  return (e as { code?: string }).code === 'TIMEOUT';
}

describe('installSmirkPageApi: response sender authentication', () => {
  it('resolves a request answered by the wallet frame (our parent)', async () => {
    const env = makeEnv();
    installWindow(env);
    assert.equal(installSmirkPageApi({ timeoutMs: 5_000 }), 'iframe-mode');

    const p = connect(env);
    env.deliver({
      data: responseFor(pendingId(env), { btc: 'wallet-key' }),
      source: env.parent,
      origin: 'https://wallet.smirk.cash',
    });

    assert.deepEqual(await p, { btc: 'wallet-key' });
    delete g['window'];
  });

  it('ignores a forged response from another frame on the page', async () => {
    const env = makeEnv();
    installWindow(env);
    installSmirkPageApi({ timeoutMs: 50 });

    const p = connect(env);
    // A nested ad frame that guessed the channel and the live request id.
    env.deliver({
      data: responseFor(pendingId(env), { btc: 'attacker-key' }),
      source: { someOtherFrame: true },
      origin: 'https://ads.example',
    });

    await assert.rejects(p, isTimeout);
    delete g['window'];
  });

  it('ignores a response whose origin is not the pinned walletOrigin', async () => {
    const env = makeEnv();
    installWindow(env);
    installSmirkPageApi({ timeoutMs: 50, walletOrigin: 'https://wallet.smirk.cash' });

    const p = connect(env);
    // Pinning also narrows the request's targetOrigin off '*'.
    assert.equal(env.posted[0]?.targetOrigin, 'https://wallet.smirk.cash');
    env.deliver({
      data: responseFor(pendingId(env), { btc: 'attacker-key' }),
      source: env.parent,
      origin: 'https://evil.example',
    });

    await assert.rejects(p, isTimeout);
    delete g['window'];
  });
});
