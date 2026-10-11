/**
 * startFeeFetch: the retry and timeout policy on its own, with a manual
 * clock, so each property is checked without mounting a screen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startFeeFetch,
  type FeeTierFetchState,
  type FeeFetchTimers,
} from '../fee-tier-fetch';
import type { FeeTiers } from '../SendWizard';

const TIERS: FeeTiers = { fast: 9, normal: 4, slow: 2 };
const OPTIONS = { timeoutMs: 100, retryDelaysMs: [10, 20] };
const ATTEMPTS = OPTIONS.retryDelaysMs.length + 1;

/** A clock the test advances by hand. */
class ManualClock implements FeeFetchTimers {
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
  startFeeFetch(
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
  startFeeFetch(() => Promise.reject(undefined), (s) => states.push(s), {
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
  const { cancel } = startFeeFetch(
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
  startFeeFetch(
    () => (++answer < ATTEMPTS ? Promise.reject(new Error('busy')) : Promise.resolve(TIERS)),
    (s) => states.push(s),
    { ...OPTIONS, timers: clock },
  );
  await flush();
  for (const delay of OPTIONS.retryDelaysMs) await clock.advance(delay);
  const attempts = states.flatMap((s) => (s.status === 'loading' ? [s.attempt] : []));
  assert.deepEqual(attempts, [...Array(ATTEMPTS).keys()].map((i) => i + 1));
  assert.deepEqual(last(states), { status: 'ready', value: TIERS });
});

test('an answer the check refuses is retried, and its reason is what the user sees', async () => {
  const clock = new ManualClock();
  const states: FeeTierFetchState[] = [];
  let asked = 0;
  startFeeFetch(
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

/** A load whose every answer the test settles by hand. */
function handLoad<T>() {
  const answers: Array<{ resolve(v: T): void; reject(e: unknown): void }> = [];
  const load = () =>
    new Promise<T>((resolve, reject) => {
      answers.push({ resolve, reject });
    });
  return { answers, load };
}

test('a valid answer that lands after the last attempt timed out is used, and clears the failure', async () => {
  // The popup's fee callback never rejects: when the fee service is silent the
  // API client gives up after 30 s and the popup answers with fallback tiers.
  // Our attempts time out sooner, so that answer arrives after `failed`.
  const clock = new ManualClock();
  const states: FeeTierFetchState[] = [];
  const { answers, load } = handLoad<FeeTiers>();
  startFeeFetch(load, (s) => states.push(s), { ...OPTIONS, timers: clock });
  for (const delay of OPTIONS.retryDelaysMs) await clock.advance(OPTIONS.timeoutMs + delay);
  await clock.advance(OPTIONS.timeoutMs);
  assert.equal(last(states)?.status, 'failed', 'every attempt timed out');
  assert.equal(answers.length, ATTEMPTS);

  answers[0]!.resolve(TIERS);
  await flush();
  assert.deepEqual(last(states), { status: 'ready', value: TIERS }, 'the late first answer is used');
  answers[1]!.resolve({ fast: 1, normal: 1, slow: 1 });
  answers[2]!.reject(new Error('later still'));
  await flush();
  assert.deepEqual(last(states), { status: 'ready', value: TIERS }, 'the first valid answer stands');
  assert.equal(clock.scheduled, 0, 'no timer is left behind');
});

test('a late answer the check refuses leaves the failure as it was', async () => {
  const clock = new ManualClock();
  const states: FeeTierFetchState[] = [];
  const { answers, load } = handLoad<FeeTiers>();
  startFeeFetch(load, (s) => states.push(s), {
    timeoutMs: 100,
    retryDelaysMs: [],
    timers: clock,
    check: (t) => (t.normal === null ? 'no normal rate' : null),
  });
  await clock.advance(100);
  const failed = last(states);
  assert.equal(failed?.status, 'failed');
  answers[0]!.resolve({ fast: 9, normal: null, slow: 2 });
  await flush();
  assert.deepEqual(last(states), failed, 'an unusable late answer changes nothing');
});

test('Retry starts a new round but keeps the requests already in flight', async () => {
  const clock = new ManualClock();
  const states: FeeTierFetchState[] = [];
  const { answers, load } = handLoad<FeeTiers>();
  const fetch = startFeeFetch(load, (s) => states.push(s), { timeoutMs: 100, retryDelaysMs: [], timers: clock });
  await clock.advance(100);
  assert.equal(last(states)?.status, 'failed');
  fetch.retry();
  assert.deepEqual(last(states), { status: 'loading', attempt: 1 }, 'Retry starts again from the first attempt');
  assert.equal(answers.length, 2, 'Retry asks again');
  answers[0]!.resolve(TIERS);
  await flush();
  assert.deepEqual(last(states), { status: 'ready', value: TIERS }, 'the earlier request still counts');
  assert.equal(clock.scheduled, 0, 'the new round stops once an answer is in');
});

test('after cancel even a valid late answer is dropped', async () => {
  const clock = new ManualClock();
  const states: FeeTierFetchState[] = [];
  const { answers, load } = handLoad<FeeTiers>();
  const fetch = startFeeFetch(load, (s) => states.push(s), { ...OPTIONS, timers: clock });
  const seen = states.length;
  fetch.cancel();
  answers[0]!.resolve(TIERS);
  await clock.advance(10_000);
  assert.equal(states.length, seen);
  fetch.retry();
  assert.equal(answers.length, 1, 'Retry does nothing once cancelled');
});

test('a check that throws is a failure the screen can show, not an escaped rejection', async () => {
  const clock = new ManualClock();
  const states: FeeTierFetchState[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (r: unknown) => unhandled.push(r);
  process.on('unhandledRejection', onUnhandled);
  try {
    startFeeFetch(() => Promise.resolve(TIERS), (s) => states.push(s), {
      timeoutMs: 100,
      retryDelaysMs: [],
      timers: clock,
      check: () => {
        throw new Error('check broke');
      },
    });
    await flush();
    assert.deepEqual(last(states), { status: 'failed', error: 'check broke' });
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
