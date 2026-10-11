/**
 * Send: the fee-tier fetches on Compose and Review must always end, never
 * leak a rejection, and never strand Send.
 *
 * Live run evidence (v0.3.1, BTC ring, first leg): the leg failed about 80 ms
 * after "Continue to review", while Review was refetching the fee tiers. The
 * refetch had no rejection handler, no timeout and no retry, and Send stays
 * disabled until it lands. It was also keyed on the `resolveFeeRates`
 * identity, which the popup renews on every session write, so the writes
 * around Continue restarted it.
 *
 * These tests mount the real SendWizard in a minimal DOM and control the fee
 * service with deferred promises. The host re-renders on every session write
 * and passes fresh callbacks each time, exactly as the extension popup's
 * HomeRouter does. Nothing is signed or broadcast: `onSubmit` is a stub.
 */

import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { h, options, render } from 'preact';
import { applyRelayFloor, InMemoryStorage, RouteController, SessionStateStore } from '@smirk/core';
import { StateProvider, useSessionState } from '../../state/hooks';
import { SendWizard, type FeeTiers, type SendSubmitResult } from '../SendWizard';
import {
  FEE_TIER_ATTEMPT_TIMEOUT_MS,
  FEE_TIER_MAX_ATTEMPTS,
  FEE_TIER_RETRY_DELAYS_MS,
} from '../fee-tier-fetch';
import {
  byTestId,
  click,
  installMiniDom,
  isDisabled,
  miniDocument,
  reviewRowValue,
  type MiniElement,
} from './mini-dom';

const DESTINATION = 'test-destination-address';
const TIERS: FeeTiers = { fast: 9, normal: 4, slow: 2 };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (v) => {
      d.settled = true;
      resolve(v);
    },
    reject: (r) => {
      d.settled = true;
      reject(r);
    },
  };
  return d;
}

/** A service whose every answer the test decides, one deferred per request. */
class Calls<T> {
  readonly calls: Array<Deferred<T>> = [];
  request = (): Promise<T> => {
    const d = deferred<T>();
    this.calls.push(d);
    return d.promise;
  };
  pending(): Array<Deferred<T>> {
    return this.calls.filter((d) => !d.settled);
  }
}

/** Let promise chains, store writes and their re-renders run to rest. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise<void>((r) => setImmediate(r));
}

function parseDecimal(decimals: number, text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m || (m[2] ?? '').length > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0'));
}

interface HostProps {
  assetId: string;
  fees: Calls<FeeTiers>;
  estimates: Calls<bigint | null>;
  submits: number[];
}

function Host({ assetId, fees, estimates, submits }: HostProps) {
  // Subscribing re-renders the host on every session write, and each render
  // hands SendWizard new callback identities, as the popup does.
  useSessionState();
  return h(SendWizard, {
    assetIds: [assetId],
    validateAddress: () => null,
    parseAmount: (id: string, text: string) => parseDecimal(id === 'btc' ? 8 : 12, text),
    resolveBalance: () => (assetId === 'btc' ? 1_000_000n : 10n ** 12n),
    resolveFeeRates: () => fees.request(),
    resolveSendFeeEstimate: () => estimates.request(),
    onSubmit: async (f: { feeRateSatPerVb: number }): Promise<SendSubmitResult> => {
      submits.push(f.feeRateSatPerVb);
      return { ok: false, error: 'stub: nothing is broadcast in this test' };
    },
    onExit: () => undefined,
  });
}

interface Mounted extends HostProps {
  root: MiniElement;
  store: SessionStateStore;
}

let restoreDom: (() => void) | null = null;
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
let mounted: Mounted | null = null;
// Preact runs effects after the next frame, which Node does not have: its
// fallback is a setTimeout, and the tests own setTimeout. Flush effects on the
// next real macrotask instead, which `settle()` drains.
const hookOptions = options as { requestAnimationFrame?: (cb: () => void) => void };
let previousRaf: typeof hookOptions.requestAnimationFrame;

beforeEach(() => {
  restoreDom = installMiniDom();
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  previousRaf = hookOptions.requestAnimationFrame;
  hookOptions.requestAnimationFrame = (cb) => {
    setImmediate(cb);
  };
  mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(async () => {
  if (mounted) {
    const { root, store } = mounted;
    render(null, root as unknown as Element);
    await settle();
    store.destroy();
    mounted = null;
  }
  await settle();
  mock.timers.reset();
  hookOptions.requestAnimationFrame = previousRaf;
  process.off('unhandledRejection', onUnhandled);
  restoreDom?.();
});

async function mount(step: number, fields: Record<string, unknown>): Promise<Mounted> {
  const store = new SessionStateStore(new InMemoryStorage());
  await store.update((s) => {
    s.wizards.send = { step, fields, startedAt: 1 };
  });
  const props: HostProps = {
    assetId: fields.fromAssetId as string,
    fees: new Calls<FeeTiers>(),
    estimates: new Calls<bigint | null>(),
    submits: [],
  };
  const root = miniDocument.createElement('div');
  render(
    h(StateProvider, { store, router: new RouteController(store) }, h(Host, props)),
    root as unknown as Element,
  );
  await settle();
  mounted = { ...props, root, store };
  return mounted;
}

const BTC_DRAFT = { fromAssetId: 'btc', toAddress: DESTINATION, amountText: '0.0001', feeTier: 'normal' };

/** Mount on Compose for a BTC send, with Compose's own fee tiers answered. */
async function mountOnCompose(): Promise<Mounted> {
  const m = await mount(2, BTC_DRAFT);
  assert.ok(m.fees.calls.length > 0, 'Compose fetches the fee tiers');
  for (const d of m.fees.pending()) d.resolve(TIERS);
  await settle();
  return m;
}

async function continueToReview(m: Mounted): Promise<number> {
  const cont = byTestId(m.root, 'send-compose-continue');
  assert.ok(cont, 'Compose shows Continue');
  assert.equal(isDisabled(cont), false, 'Continue is enabled once Compose has a rate');
  const before = m.fees.calls.length;
  click(cont);
  await settle();
  assert.ok(byTestId(m.root, 'send-review-submit'), 'Review is showing');
  return before;
}

/** Re-render the host the way balance refreshes and wizard patches do. */
async function sessionWrites(m: Mounted, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await m.store.update((s) => {
      s.ui.balanceHidden = !s.ui.balanceHidden;
    });
    await settle();
  }
}

async function advance(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await settle();
}

async function failPending(m: Mounted, reason: string): Promise<void> {
  for (const d of m.fees.pending()) d.reject(new Error(reason));
  await settle();
}

function sendButton(m: Mounted): MiniElement {
  const send = byTestId(m.root, 'send-review-submit');
  assert.ok(send, 'Review shows Send');
  return send;
}

test('a Review fee refetch that rejects 80 ms after Continue is handled, shown, and retryable', async () => {
  const m = await mountOnCompose();
  const before = await continueToReview(m);
  assert.ok(m.fees.calls.length > before, 'Review refetches the tiers on mount');
  assert.equal(isDisabled(sendButton(m)), true, 'Send waits for the refetched rate');

  await advance(80);
  await failPending(m, 'fee service unavailable');
  // Exhaust the bounded automatic retries, failing each one.
  for (const delay of FEE_TIER_RETRY_DELAYS_MS) {
    assert.equal(byTestId(m.root, 'send-review-fee-error'), null, 'no error while attempts remain');
    await advance(delay);
    await failPending(m, 'fee service unavailable');
  }

  assert.deepEqual(unhandled, [], 'no fee rejection escapes as an unhandled rejection');
  const error = byTestId(m.root, 'send-review-fee-error');
  assert.ok(error, 'Review shows the fee failure');
  assert.match(error.textContent, /fee service unavailable/, 'the error names the cause it caught');
  assert.equal(isDisabled(sendButton(m)), true, 'Send stays off without a current rate');
  assert.equal(m.fees.pending().length, 0, 'nothing is left in flight');

  const retry = byTestId(m.root, 'send-review-fee-retry');
  assert.ok(retry, 'Review offers Retry');
  click(retry);
  await settle();
  assert.equal(m.fees.pending().length, 1, 'Retry asks the fee service again');
  m.fees.pending()[0]!.resolve(TIERS);
  await settle();
  assert.equal(byTestId(m.root, 'send-review-fee-error'), null, 'the error clears once the rate lands');
  assert.match(reviewRowValue(m.root, 'Fee tier') ?? '', /^normal \([\d.]+ sat\/vB\)$/);
  assert.equal(isDisabled(sendButton(m)), false, 'Send is enabled with the refetched rate');

  click(sendButton(m));
  await settle();
  assert.deepEqual(m.submits, [applyRelayFloor(TIERS.normal!)], 'Send ships the refetched, floored rate');
});

test('session writes around Continue do not restart the Review refetch or discard its answer', async () => {
  const m = await mountOnCompose();
  const before = await continueToReview(m);
  const afterMount = m.fees.calls.length;
  await sessionWrites(m, 3);
  assert.equal(m.fees.calls.length, afterMount, 'a re-render with a new callback identity does not refetch');
  assert.equal(afterMount - before, 1, 'Review asks once per mount');

  // The one request Review made answers: that answer must be used.
  m.fees.calls[before]!.resolve(TIERS);
  await settle();
  assert.equal(isDisabled(sendButton(m)), false, 'Send is enabled by the refetch it started');
  assert.deepEqual(unhandled, []);
});

test('a Review fee refetch that never answers times out, retries a bounded number of times, then offers Retry', async () => {
  const m = await mountOnCompose();
  const before = await continueToReview(m);

  for (let i = 0; i < FEE_TIER_MAX_ATTEMPTS; i++) {
    assert.equal(byTestId(m.root, 'send-review-fee-error'), null, 'no error while attempts remain');
    await advance(FEE_TIER_ATTEMPT_TIMEOUT_MS);
    const delay = FEE_TIER_RETRY_DELAYS_MS[i];
    if (delay !== undefined) await advance(delay);
  }
  assert.equal(m.fees.calls.length - before, FEE_TIER_MAX_ATTEMPTS, 'one request per attempt, no more');
  const error = byTestId(m.root, 'send-review-fee-error');
  assert.ok(error, 'Review says the rate did not load');
  assert.match(error.textContent, /did not answer/, 'the error says it timed out');
  assert.ok(byTestId(m.root, 'send-review-fee-retry'), 'Review offers Retry');
  assert.equal(isDisabled(sendButton(m)), true);

  // Bounded: an hour later nothing else has been asked.
  await advance(60 * 60_000);
  assert.equal(m.fees.calls.length - before, FEE_TIER_MAX_ATTEMPTS, 'no automatic retry after the last attempt');

  // A late answer after the final failure does not flip Send on under the
  // error it is still showing; Retry is the way back.
  for (const d of m.fees.pending()) d.resolve(TIERS);
  await settle();
  assert.ok(byTestId(m.root, 'send-review-fee-error'));
  assert.equal(isDisabled(sendButton(m)), true);
  assert.deepEqual(unhandled, []);
});

test('a slow first answer that lands while the retry is running is used', async () => {
  const m = await mountOnCompose();
  const before = await continueToReview(m);
  await advance(FEE_TIER_ATTEMPT_TIMEOUT_MS);
  assert.match(reviewRowValue(m.root, 'Fee tier') ?? '', /retrying/, 'the row says it is retrying');
  await advance(FEE_TIER_RETRY_DELAYS_MS[0]!);
  assert.equal(m.fees.calls.length - before, 2, 'the retry is in flight');
  m.fees.calls[before]!.resolve(TIERS);
  await settle();
  assert.equal(isDisabled(sendButton(m)), false, 'the first valid rate enables Send');
  // The retry failing later changes nothing and leaks nothing.
  m.fees.calls[before + 1]!.reject(new Error('late failure'));
  await settle();
  await advance(FEE_TIER_ATTEMPT_TIMEOUT_MS);
  assert.equal(byTestId(m.root, 'send-review-fee-error'), null);
  assert.equal(isDisabled(sendButton(m)), false);
  assert.deepEqual(unhandled, []);
});

test('a refetched tier set without the chosen rate is a visible failure, not an endless "loading"', async () => {
  const m = await mountOnCompose();
  await continueToReview(m);
  for (let i = 0; i < FEE_TIER_MAX_ATTEMPTS; i++) {
    for (const d of m.fees.pending()) d.resolve({ fast: 9, normal: null, slow: 2 });
    await settle();
    const delay = FEE_TIER_RETRY_DELAYS_MS[i];
    if (delay !== undefined) await advance(delay);
  }
  const error = byTestId(m.root, 'send-review-fee-error');
  assert.ok(error, 'Review explains the missing rate');
  assert.match(error.textContent, /normal/, 'the error names the tier it could not price');
  assert.doesNotMatch(reviewRowValue(m.root, 'Fee tier') ?? '', /loading/, 'the row no longer claims to be loading');
  assert.equal(isDisabled(sendButton(m)), true);
});

test('leaving Review while the refetch is in flight leaks no rejection', async () => {
  const m = await mountOnCompose();
  await continueToReview(m);
  const pending = m.fees.pending();
  assert.ok(pending.length > 0, 'Review has a request in flight');
  render(null, m.root as unknown as Element);
  await settle();
  for (const d of pending) d.reject(new Error('answered after unmount'));
  await settle();
  const asked = m.fees.calls.length;
  await advance(FEE_TIER_ATTEMPT_TIMEOUT_MS * FEE_TIER_MAX_ATTEMPTS);
  assert.equal(m.fees.calls.length, asked, 'no retry starts after unmount');
  assert.deepEqual(unhandled, []);
});

test('Compose: a failed tier fetch ends in a retryable error, and Retry enables Continue', async () => {
  const m = await mount(2, BTC_DRAFT);
  await sessionWrites(m, 2);
  assert.equal(m.fees.calls.length, 1, 'Compose asks once, whatever re-renders around it');
  await failPending(m, 'electrum unreachable');
  for (const delay of FEE_TIER_RETRY_DELAYS_MS) {
    await advance(delay);
    await failPending(m, 'electrum unreachable');
  }
  const error = byTestId(m.root, 'send-fee-error');
  assert.ok(error, 'Compose shows the failure');
  assert.match(error.textContent, /electrum unreachable/);
  const cont = byTestId(m.root, 'send-compose-continue');
  assert.ok(cont);
  assert.equal(isDisabled(cont), true, 'Continue waits for a rate');

  const retry = byTestId(m.root, 'send-fee-retry');
  assert.ok(retry, 'Compose offers Retry');
  click(retry);
  await settle();
  for (const d of m.fees.pending()) d.resolve(TIERS);
  await settle();
  assert.equal(byTestId(m.root, 'send-fee-error'), null);
  assert.equal(isDisabled(byTestId(m.root, 'send-compose-continue')!), false, 'Continue is enabled');
  assert.deepEqual(unhandled, []);
});

test('XMR Review: session writes do not restart the fee estimate, so Send is not held behind "Estimating…"', async () => {
  const m = await mount(3, { fromAssetId: 'xmr', toAddress: DESTINATION, amountText: '0.01', feeTier: 'normal' });
  assert.equal(m.estimates.calls.length, 1, 'Review asks for one estimate');
  assert.equal(isDisabled(sendButton(m)), true, 'Send waits for the estimate');
  await sessionWrites(m, 3);
  assert.equal(m.estimates.calls.length, 1, 'a re-render with a new callback identity does not re-estimate');
  m.estimates.calls[0]!.resolve(30_000_000n);
  await settle();
  assert.match(reviewRowValue(m.root, 'Network fee') ?? '', /^~/, 'Review shows the estimate');
  assert.equal(isDisabled(sendButton(m)), false, 'Send is enabled once the estimate settles');
  assert.equal(m.fees.calls.length, 0, 'XMR has no fee tiers to fetch');
});
