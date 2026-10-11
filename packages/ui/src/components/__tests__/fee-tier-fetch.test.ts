/**
 * startFeeTierFetch: the retry and timeout policy on its own, with a manual
 * clock, so each property is checked without mounting a screen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startFeeTierFetch,
  type FeeTierFetchState,
  type FeeTierFetchTimers,
} from '../fee-tier-fetch';
import type { FeeTiers } from '../SendWizard';

const TIERS: FeeTiers = { fast: 9, normal: 4, slow: 2 };
const OPTIONS = { timeoutMs: 100, retryDelaysMs: [10, 20] };
const ATTEMPTS = OPTIONS.retryDelaysMs.length + 1;

/** A clock the test advances by hand. */
class ManualClock implements FeeTierFetchTimers {
  private now = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  get scheduled(): number {
    return this.timers.size;
  }
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
      await flush();
    }
    this.now = until;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

function last(states: FeeTierFetchState[]): FeeTierFetchState | undefined {
  return states[states.length - 1];
}

test('a synchronous throw from the fee callback is handled like a rejection', async () => {
  const clock = new ManualClock();
  const states: FeeTierFetchState[] = [];
  let asked = 0;
  startFeeTierFetch(
    () => {
      asked++;
      throw new Error('provider not ready');
    },
    (s) => states.push(s),
    { ...OPTIONS, timers: clock },
  );
  await flush();
  for (const delay of OPTIONS.retryDelaysMs) await clock.advance(delay);
  assert.equal(asked, ATTEMPTS);
  assert.deepEqual(last(states), { status: 'failed', error: 'provider not ready' });
  assert.equal(clock.scheduled, 0, 'no timer is left behind');
});

test('a rejection that is not an Error still produces a readable cause', async () => {
  const clock = new ManualClock();
  const states: FeeTierFetchState[] = [];
  startFeeTierFetch(() => Promise.reject(undefined), (s) => states.push(s), {
    timeoutMs: 100,
    retryDelaysMs: [],
    timers: clock,
  });
  await flush();
  const end = last(states);
  assert.equal(end?.status, 'failed');
  assert.ok(end?.status === 'failed' && end.error.length > 0, 'the error is never blank');
});

test('cancel stops every callback, timer and retry, and swallows late rejections', async () => {
  const clock = new ManualClock();
  const states: FeeTierFetchState[] = [];
  let rejectIt!: (e: unknown) => void;
  let asked = 0;
  const cancel = startFeeTierFetch(
    () => {
      asked++;
      return new Promise<FeeTiers>((_, reject) => {
        rejectIt = reject;
      });
    },
    (s) => states.push(s),
    { ...OPTIONS, timers: clock },
  );
  const seen = states.length;
  cancel();
  assert.equal(clock.scheduled, 0, 'cancel clears the attempt timeout');
  rejectIt(new Error('after cancel'));
  await clock.advance(10_000);
  assert.equal(states.length, seen, 'no state after cancel');
  assert.equal(asked, 1, 'no retry after cancel');
});

test('loading reports the attempt number, so the screen can say it is retrying', async () => {
  const clock = new ManualClock();
  const states: FeeTierFetchState[] = [];
  let answer = 0;
  startFeeTierFetch(
    () => (++answer < ATTEMPTS ? Promise.reject(new Error('busy')) : Promise.resolve(TIERS)),
    (s) => states.push(s),
    { ...OPTIONS, timers: clock },
  );
  await flush();
  for (const delay of OPTIONS.retryDelaysMs) await clock.advance(delay);
  const attempts = states.flatMap((s) => (s.status === 'loading' ? [s.attempt] : []));
  assert.deepEqual(attempts, [...Array(ATTEMPTS).keys()].map((i) => i + 1));
  assert.deepEqual(last(states), { status: 'ready', tiers: TIERS });
});

test('an answer the check refuses is retried, and its reason is what the user sees', async () => {
  const clock = new ManualClock();
  const states: FeeTierFetchState[] = [];
  let asked = 0;
  startFeeTierFetch(
    () => {
      asked++;
      return Promise.resolve({ fast: null, normal: null, slow: null });
    },
    (s) => states.push(s),
    { ...OPTIONS, timers: clock, check: (t) => (t.normal === null ? 'no normal rate' : null) },
  );
  await flush();
  for (const delay of OPTIONS.retryDelaysMs) await clock.advance(delay);
  assert.equal(asked, ATTEMPTS);
  assert.deepEqual(last(states), { status: 'failed', error: 'no normal rate' });
});
