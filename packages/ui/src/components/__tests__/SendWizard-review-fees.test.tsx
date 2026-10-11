/**
 * Send: the fee fetches on Compose and Review must always end, never leak a
 * rejection, never strand Send or Continue, and never sign at a rate the
 * screen did not show.
 *
 * The Review refetch used to be a bare `resolveFeeRates(assetId).then(...)`
 * keyed on the callback's identity, which the popup renews on every session
 * write. Nothing handled a rejection, nothing ended a request that never
 * answered, and the writes around Continue restarted it.
 *
 * What these tests do not claim: that the v0.3.1 live run's first BTC leg,
 * lost about 80 ms after "Continue to review", was an unhandled rejection
 * from this refetch. The popup's fee callback cannot reject (the API client
 * turns every fetch, abort and parse failure into `{ error }`, and the popup
 * turns that into fallback tiers), and at that point the live lane read the
 * Review rows at once and asserted a sat/vB rate while the row still read
 * "normal (loading…)". The lane now waits for the rate (#41).
 *
 * These tests mount the real SendWizard in a minimal DOM and control the fee
 * service with deferred promises. The host re-renders on every session write
 * and passes fresh callbacks each time, exactly as the extension popup's
 * HomeRouter does. Where timing matters, the fee callback is the popup's own
 * mapping over the real API client, with a fetch that never answers. Nothing
 * is signed or broadcast: `onSubmit` is a stub.
 */

import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { h, options, render } from 'preact';
import {
  applyRelayFloor,
  createChainProviders,
  fallbackFeeTiers,
  InMemoryStorage,
  RouteController,
  SessionStateStore,
  SmirkApi,
} from '@smirk/core';
import { StateProvider, useSessionState } from '../../state/hooks';
import { SendWizard, type FeeTiers, type SendSubmitResult } from '../SendWizard';
import {
  FEE_ESTIMATE_TIMEOUT_MS,
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
  counts: Calls<number | null>;
  submits: number[];
  /** Replaces `fees` as the fee callback, for the popup's real mapping. */
  feeRates?: ((assetId: string) => Promise<FeeTiers>) | undefined;
}

function Host({ assetId, fees, estimates, counts, submits, feeRates }: HostProps) {
  // Subscribing re-renders the host on every session write, and each render
  // hands SendWizard new callback identities, as the popup does.
  useSessionState();
  return h(SendWizard, {
    assetIds: [assetId],
    validateAddress: () => null,
    parseAmount: (id: string, text: string) => parseDecimal(id === 'btc' || id === 'ltc' ? 8 : 12, text),
    resolveBalance: (id: string) => (id === 'btc' || id === 'ltc' ? 1_000_000n : 10n ** 12n),
    resolveFeeRates: (id: string) => (feeRates ? feeRates(id) : fees.request()),
    resolveSendFeeEstimate: () => estimates.request(),
    resolveSweepInputCount: () => counts.request(),
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

async function mount(
  step: number,
  fields: Record<string, unknown>,
  feeRates?: (assetId: string) => Promise<FeeTiers>,
): Promise<Mounted> {
  const store = new SessionStateStore(new InMemoryStorage());
  await store.update((s) => {
    s.wizards.send = { step, fields, startedAt: 1 };
  });
  const props: HostProps = {
    assetId: fields.fromAssetId as string,
    fees: new Calls<FeeTiers>(),
    estimates: new Calls<bigint | null>(),
    counts: new Calls<number | null>(),
    submits: [],
    feeRates,
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

/**
 * Whether `testid` is on screen. A boolean, so a failing assert prints at
 * once: inspecting a mini-DOM element walks the whole tree and stalls the run.
 */
function shown(root: MiniElement, testid: string): boolean {
  return byTestId(root, testid) !== null;
}

function sendButton(m: Mounted): MiniElement {
  const send = byTestId(m.root, 'send-review-submit');
  assert.ok(send, 'Review shows Send');
  return send;
}

test('a Review fee refetch that rejects soon after Continue is handled, shown, and retryable', async () => {
  const m = await mountOnCompose();
  const before = await continueToReview(m);
  assert.ok(m.fees.calls.length > before, 'Review refetches the tiers on mount');
  assert.equal(isDisabled(sendButton(m)), true, 'Send waits for the refetched rate');

  await advance(80);
  await failPending(m, 'fee service unavailable');
  // Exhaust the bounded automatic retries, failing each one.
  for (const delay of FEE_TIER_RETRY_DELAYS_MS) {
    assert.equal(shown(m.root, 'send-review-fee-error'), false, 'no error while attempts remain');
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
  assert.equal(shown(m.root, 'send-review-fee-error'), false, 'the error clears once the rate lands');
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
    assert.equal(shown(m.root, 'send-review-fee-error'), false, 'no error while attempts remain');
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

  // A valid answer that lands after the final failure is used: the error
  // goes, the row shows the rate it will sign at, and only then is Send on.
  // The popup's fallback for a silent fee service arrives exactly this way.
  m.fees.calls[before]!.resolve(TIERS);
  await settle();
  assert.equal(shown(m.root, 'send-review-fee-error'), false, 'the late rate clears the error');
  assert.match(reviewRowValue(m.root, 'Fee tier') ?? '', /^normal \([\d.]+ sat\/vB\)$/);
  assert.equal(isDisabled(sendButton(m)), false, 'Send is enabled by the late rate');
  click(sendButton(m));
  await settle();
  assert.deepEqual(m.submits, [applyRelayFloor(TIERS.normal!)], 'Send ships the rate the row showed');
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
  assert.equal(shown(m.root, 'send-review-fee-error'), false);
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
  assert.equal(shown(m.root, 'send-fee-error'), false);
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

// ---------------------------------------------------------------------------
// The popup's own fee path, against a fee service that accepts the connection
// and never replies.
// ---------------------------------------------------------------------------

/**
 * The extension popup's `resolveFeeRates`, line for line, over the real API
 * client and chain provider: any error, or no normal rate, becomes the
 * floored fallback tiers. It never rejects.
 */
function popupFeeRates(api: SmirkApi): (assetId: string) => Promise<FeeTiers> {
  const providers = createChainProviders(api);
  return async (assetId) => {
    if (assetId !== 'btc' && assetId !== 'ltc') return { fast: null, normal: null, slow: null };
    const r = await providers.utxo(assetId).estimateFee();
    if (r.error || r.data?.model !== 'rate-estimate' || r.data.normal == null) return fallbackFeeTiers();
    return { fast: r.data.fast, normal: r.data.normal, slow: r.data.slow };
  };
}

/** A fetch that never answers; only the client's own abort ends it. */
function installSilentFetch(): { requests: () => number; open: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let requests = 0;
  let open = 0;
  globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
    requests++;
    open++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        open--;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  }) as typeof fetch;
  return { requests: () => requests, open: () => open, restore: () => { globalThis.fetch = original; } };
}

/** Advance the clock a second at a time until `done`, for at most `limitMs`. */
async function advanceUntil(done: () => boolean, limitMs: number): Promise<number> {
  let waited = 0;
  while (!done() && waited < limitMs) {
    await advance(1_000);
    waited += 1_000;
  }
  return waited;
}

const FALLBACK_RATE = applyRelayFloor(fallbackFeeTiers().normal);

test('Review: a fee service that never replies ends on the popup fallback rate, and Send turns on', async () => {
  const silent = installSilentFetch();
  try {
    const m = await mount(3, BTC_DRAFT, popupFeeRates(new SmirkApi('https://fee-service.invalid')));
    assert.equal(isDisabled(sendButton(m)), true, 'Send waits for a rate');
    await advanceUntil(() => !isDisabled(sendButton(m)), 5 * 60_000);
    assert.equal(isDisabled(sendButton(m)), false, 'the fallback rate enables Send');
    assert.equal(shown(m.root, 'send-review-fee-error'), false, 'no failure is left on screen');
    assert.equal(reviewRowValue(m.root, 'Fee tier'), `normal (${FALLBACK_RATE} sat/vB)`, 'the row shows the fallback rate');
    click(sendButton(m));
    await settle();
    assert.deepEqual(m.submits, [FALLBACK_RATE], 'Send ships the rate the row showed');
    assert.deepEqual(unhandled, []);
  } finally {
    silent.restore();
  }
});

test('Review: Retry after the attempts give up still takes the answer already on its way', async () => {
  const silent = installSilentFetch();
  try {
    const m = await mount(3, BTC_DRAFT, popupFeeRates(new SmirkApi('https://fee-service.invalid')));
    await advanceUntil(() => byTestId(m.root, 'send-review-fee-error') !== null, 5 * 60_000);
    const retry = byTestId(m.root, 'send-review-fee-retry');
    assert.ok(retry, 'the attempts gave up before the client did, and Review offers Retry');
    click(retry);
    await settle();
    const asked = silent.requests();
    await advanceUntil(() => !isDisabled(sendButton(m)), 5 * 60_000);
    assert.equal(isDisabled(sendButton(m)), false, 'Send turns on');
    assert.ok(silent.open() > 0, "Send turned on before Retry's own request was answered");
    assert.equal(silent.requests(), asked, 'nothing new was asked to get there');
    assert.equal(reviewRowValue(m.root, 'Fee tier'), `normal (${FALLBACK_RATE} sat/vB)`);
    assert.deepEqual(unhandled, []);
  } finally {
    silent.restore();
  }
});

test('Compose: a fee service that never replies ends on the popup fallback tiers, and Continue turns on', async () => {
  const silent = installSilentFetch();
  try {
    const m = await mount(2, BTC_DRAFT, popupFeeRates(new SmirkApi('https://fee-service.invalid')));
    const cont = () => byTestId(m.root, 'send-compose-continue')!;
    assert.equal(isDisabled(cont()), true, 'Continue waits for a rate');
    await advanceUntil(() => !isDisabled(cont()), 5 * 60_000);
    assert.equal(isDisabled(cont()), false, 'the fallback tiers enable Continue');
    assert.equal(shown(m.root, 'send-fee-error'), false, 'no failure is left on screen');
    assert.ok(byTestId(m.root, 'send-fee-tier-normal'), 'the tiers are shown');
    assert.deepEqual(unhandled, []);
  } finally {
    silent.restore();
  }
});

// ---------------------------------------------------------------------------
// Compose's other fee lookups: keyed on what they ask, not on the callback.
// ---------------------------------------------------------------------------

const XMR_MAX = { fromAssetId: 'xmr', toAddress: DESTINATION, amountText: '', feeTier: 'normal', sweep: true };

test('XMR Compose Max: session writes neither re-estimate nor turn Continue off', async () => {
  const m = await mount(2, XMR_MAX);
  assert.equal(m.estimates.calls.length, 1, 'Compose asks once, its own draft write included');
  for (const d of m.estimates.pending()) d.resolve(30_000_000n);
  await settle();
  const cont = () => byTestId(m.root, 'send-compose-continue')!;
  assert.equal(isDisabled(cont()), false, 'Max can continue once the estimate is in');
  await sessionWrites(m, 3);
  assert.equal(m.estimates.calls.length, 1, 'a re-render with a new callback identity does not re-estimate');
  assert.equal(isDisabled(cont()), false, 'Continue stays on');
  assert.deepEqual(unhandled, []);
});

test('XMR Compose Max: an estimate that never answers ends in a visible failure, and Retry enables Continue', async () => {
  const m = await mount(2, XMR_MAX);
  const cont = () => byTestId(m.root, 'send-compose-continue')!;
  assert.ok(byTestId(m.root, 'send-fee-estimate-loading'), 'Compose says it is estimating');
  assert.equal(shown(m.root, 'send-fee-estimate-error'), false);
  await advance(FEE_ESTIMATE_TIMEOUT_MS);
  const error = byTestId(m.root, 'send-fee-estimate-error');
  assert.ok(error, 'Compose says the estimate did not arrive');
  assert.match(error.textContent, /did not answer/, 'the error names the cause it caught');
  assert.equal(isDisabled(cont()), true, 'Max cannot continue without a fee');
  await advance(60 * 60_000);
  assert.equal(m.estimates.calls.length, 1, 'no automatic re-estimate');

  const retry = byTestId(m.root, 'send-fee-estimate-retry');
  assert.ok(retry, 'Compose offers Retry');
  click(retry);
  await settle();
  assert.equal(m.estimates.calls.length, 2, 'Retry asks again');
  m.estimates.calls[1]!.resolve(30_000_000n);
  await settle();
  assert.equal(shown(m.root, 'send-fee-estimate-error'), false, 'the error clears');
  assert.equal(isDisabled(cont()), false, 'Continue is enabled');
  assert.deepEqual(unhandled, []);
});

test('XMR Compose Max: an estimate that comes back empty is a visible failure, not a silent dead end', async () => {
  const m = await mount(2, XMR_MAX);
  for (const d of m.estimates.pending()) d.resolve(null);
  await settle();
  assert.ok(byTestId(m.root, 'send-fee-estimate-error'), 'Compose explains why Max cannot continue');
  assert.equal(isDisabled(byTestId(m.root, 'send-compose-continue')!), true);
});

test('XMR Compose with an amount: a failed estimate stays quiet and does not hold Continue', async () => {
  const m = await mount(2, { fromAssetId: 'xmr', toAddress: DESTINATION, amountText: '0.01', feeTier: 'normal' });
  for (const d of m.estimates.pending()) d.reject(new Error('lws unavailable'));
  await settle();
  await advance(FEE_TIER_ATTEMPT_TIMEOUT_MS * FEE_TIER_MAX_ATTEMPTS * 2);
  assert.equal(shown(m.root, 'send-fee-estimate-error'), false, 'the estimate only informs a normal send');
  assert.equal(isDisabled(byTestId(m.root, 'send-compose-continue')!), false);
  assert.deepEqual(unhandled, []);
});

test('Grin Compose: session writes do not replay the fee estimate', async () => {
  const m = await mount(2, { fromAssetId: 'grin', toAddress: DESTINATION, amountText: '1', feeTier: 'normal' });
  const asked = m.estimates.calls.length;
  assert.ok(asked > 0, 'Compose estimates the Grin fee for the amount');
  await sessionWrites(m, 3);
  assert.equal(m.estimates.calls.length, asked, 'a re-render with a new callback identity does not re-estimate');
});

test('BTC Compose Max: session writes do not re-count the sweep inputs', async () => {
  const m = await mount(2, { ...BTC_DRAFT, sweep: true });
  const asked = m.counts.calls.length;
  assert.ok(asked > 0, 'Compose asks how many inputs the sweep spends');
  await sessionWrites(m, 3);
  assert.equal(m.counts.calls.length, asked, 'a re-render with a new callback identity does not re-count');
});

// ---------------------------------------------------------------------------
// Review never signs with a rate fetched for something else, and signs once.
// ---------------------------------------------------------------------------

test('Review: a draft whose coin changes in place never sends at the previous coin\'s rate', async () => {
  const m = await mount(3, BTC_DRAFT);
  for (const d of m.fees.pending()) d.resolve({ fast: 50, normal: 40, slow: 30 });
  await settle();
  assert.equal(isDisabled(sendButton(m)), false, 'BTC is ready to send at its own rate');

  // Hold effects, as a slow frame would, so the screen renders the new coin
  // before any fetch for it can start.
  let held: (() => void) | null = null;
  hookOptions.requestAnimationFrame = (cb) => {
    held = cb;
  };
  try {
    await m.store.update((s) => {
      (s.wizards.send!.fields as Record<string, unknown>).fromAssetId = 'ltc';
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.match(reviewRowValue(m.root, 'Asset') ?? '', /LTC/, 'Review now shows Litecoin');
    assert.doesNotMatch(reviewRowValue(m.root, 'Fee tier') ?? '', /sat\/vB/, 'no rate is shown for a coin not yet priced');
    assert.equal(isDisabled(sendButton(m)), true, 'Send waits for a Litecoin rate');
    click(sendButton(m));
    await Promise.resolve();
    assert.deepEqual(m.submits, [], 'nothing is sent at the Bitcoin rate');
  } finally {
    hookOptions.requestAnimationFrame = (cb) => {
      setImmediate(cb);
    };
    const release = held as (() => void) | null;
    if (release) setImmediate(release);
    await settle();
  }
  const ltc = m.fees.pending();
  assert.ok(ltc.length > 0, 'Review asks for the Litecoin rate');
  for (const d of ltc) d.resolve({ fast: 9, normal: 4, slow: 2 });
  await settle();
  click(sendButton(m));
  await settle();
  assert.deepEqual(m.submits, [applyRelayFloor(4)], 'Send ships the Litecoin rate it showed');
});

test('Review: two clicks dispatched in the same task submit once', async () => {
  const m = await mount(3, BTC_DRAFT);
  for (const d of m.fees.pending()) d.resolve(TIERS);
  await settle();
  const send = sendButton(m);
  click(send);
  click(send);
  await settle();
  assert.equal(m.submits.length, 1, 'one send per press of Send');
  click(sendButton(m));
  await settle();
  assert.equal(m.submits.length, 2, 'a later press after the first one finished is allowed');
});
