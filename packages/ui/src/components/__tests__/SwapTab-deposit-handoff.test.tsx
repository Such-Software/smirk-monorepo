/**
 * The deposit step's "Open Send → pre-filled" moves the swap to its status
 * step only when Send opened.
 *
 * Review of #50: the tap handed the deposit to Send and then moved the swap
 * to its status step unconditionally. A user with a Send draft who answered
 * Cancel to "Replace it with this swap deposit?" kept the draft, and the swap
 * still moved on. The status step has no back button and no pay action at
 * "Waiting for your deposit", and a THORChain memo deposit never shows its
 * vault address, so the quoted deposit could no longer be paid from the
 * wallet: the user had to cancel the swap and get a new quote.
 *
 * These tests mount the real SwapTab in a minimal DOM on a swap's deposit
 * step and press the real button. The consumer's handler is a stub that
 * answers whether Send opened; nothing is sent.
 */

import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { h, options, render } from 'preact';
import { InMemoryStorage, RouteController, SessionStateStore } from '@smirk/core';
import { StateProvider } from '../../state/hooks';
import {
  SwapTab,
  THORCHAIN_WIZARD_ID,
  TROCADOR_WIZARD_ID,
  type OpenSendHandler,
  type SwapInFlight,
  type ThorchainHandlers,
} from '../SwapTab';
import { byTestId, click, installMiniDom, miniDocument, type MiniElement } from './mini-dom';

/** Let promise chains, store writes and their re-renders run to rest. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise<void>((r) => setImmediate(r));
}

const notInThisTest = async (): Promise<never> => {
  throw new Error('not in this test');
};

const TROCADOR_DEPOSIT: SwapInFlight = {
  id: 'TrocadorTrade1',
  fromAsset: 'btc',
  toAsset: 'ltc',
  fromAmountAtomic: '300000',
  toAmountEstimateAtomic: '65120000',
  depositAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  provider: 'trocador',
  state: { state: 'pending', reason: 'awaiting_deposit' },
};

const THORCHAIN_DEPOSIT: SwapInFlight = {
  id: 'ABCDEF0123456789',
  fromAsset: 'btc',
  toAsset: 'ltc',
  fromAmountAtomic: '6201',
  toAmountEstimateAtomic: '1300000',
  depositAddress: 'bc1qjc86s9s508ttkryzsk35agghhv664a6an5eclv',
  provider: 'thorchain',
  memo: '=:l:ltc1qp6r3vr50h7ehdq5qw2k8alzqwjq76xd5ux38mz:1',
  depositBeforeMs: 1_800_000_000_000,
  state: { state: 'pending', reason: 'awaiting_deposit' },
};

const THORCHAIN_LIVE: ThorchainHandlers = {
  fromAssets: ['btc'],
  toAssets: ['ltc'],
  onQuote: notInThisTest,
  onConfirm: notInThisTest,
};

const PROVIDERS = [
  ['Trocador', TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT],
  ['THORChain', THORCHAIN_WIZARD_ID, THORCHAIN_DEPOSIT],
] as const;

interface Mounted {
  root: MiniElement;
  store: SessionStateStore;
  handedOff: SwapInFlight[];
}

let restoreDom: (() => void) | null = null;
let mounted: Mounted | null = null;
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
// Preact runs effects after the next frame, which Node does not have.
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
});

afterEach(async () => {
  if (mounted) {
    render(null, mounted.root as unknown as Element);
    await settle();
    mounted.store.destroy();
    mounted = null;
  }
  await settle();
  hookOptions.requestAnimationFrame = previousRaf;
  process.off('unhandledRejection', onUnhandled);
  restoreDom?.();
  assert.deepEqual(unhandled, [], 'no unhandled rejection');
});

/** The Swap tab on `deposit`'s deposit step, with `answer` as the consumer's "did Send open". */
async function mountOnDepositStep(
  wizardId: string,
  deposit: SwapInFlight,
  answer: (deposit: SwapInFlight) => ReturnType<OpenSendHandler>,
): Promise<Mounted> {
  const store = new SessionStateStore(new InMemoryStorage());
  await store.update((s) => {
    s.route = { current: 'swap' };
    s.wizards[wizardId] = { step: 0, startedAt: 1, fields: { step: 2, inFlight: deposit } };
  });
  const handedOff: SwapInFlight[] = [];
  const root = miniDocument.createElement('div');
  render(
    h(
      StateProvider,
      { store, router: new RouteController(store) },
      h(SwapTab, {
        fromAssets: ['btc'],
        toAssets: ['ltc'],
        resolveBalance: () => null,
        parseAmount: () => null,
        onTrocadorQuote: notInThisTest,
        onTrocadorConfirm: notInThisTest,
        onOpenSend: (d: SwapInFlight) => {
          handedOff.push(d);
          return answer(d);
        },
        thorchain: THORCHAIN_LIVE,
      }),
    ),
    root as unknown as Element,
  );
  await settle();
  mounted = { root, store, handedOff };
  return mounted;
}

async function pressOpenSend(m: Mounted): Promise<void> {
  const button = byTestId(m.root, 'swap-deposit-open-send');
  assert.ok(button, 'the deposit step offers Open Send');
  click(button);
  await settle();
}

async function swapStep(m: Mounted, wizardId: string): Promise<unknown> {
  return (await m.store.load()).wizards[wizardId]?.fields.step;
}

for (const [provider, wizardId, deposit] of PROVIDERS) {
  test(`${provider}: when Send does not open, the swap stays on its deposit step`, async () => {
    const m = await mountOnDepositStep(wizardId, deposit, () => Promise.resolve(false));
    await pressOpenSend(m);

    assert.deepEqual(m.handedOff, [deposit], 'the deposit was handed to the consumer once');
    assert.equal(await swapStep(m, wizardId), 2, 'the swap did not move to its status step');
    assert.equal(byTestId(m.root, 'swap-status-state'), null, 'the status step is not showing');
    assert.ok(byTestId(m.root, 'swap-deposit-open-send'), 'the deposit can still be handed to Send');
  });

  test(`${provider}: when Send opens, the swap moves to its status step`, async () => {
    const m = await mountOnDepositStep(wizardId, deposit, () => Promise.resolve(true));
    await pressOpenSend(m);

    assert.deepEqual(m.handedOff, [deposit]);
    assert.equal(await swapStep(m, wizardId), 3);
    assert.ok(byTestId(m.root, 'swap-status-state'), 'the status step is showing');
  });
}

test('a consumer that does not answer is taken as Send having opened', async () => {
  const m = await mountOnDepositStep(TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, () => undefined);
  await pressOpenSend(m);
  assert.equal(await swapStep(m, TROCADOR_WIZARD_ID), 3);
});

test('a handoff that fails leaves the swap on its deposit step and says why', async () => {
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    const m = await mountOnDepositStep(TROCADOR_WIZARD_ID, TROCADOR_DEPOSIT, () =>
      Promise.reject(new Error('storage is unavailable')),
    );
    await pressOpenSend(m);
    assert.equal(await swapStep(m, TROCADOR_WIZARD_ID), 2);
    assert.ok(byTestId(m.root, 'swap-deposit-open-send'));
    assert.ok(
      warn.mock.calls.some((c) => c.arguments.some((a) => a instanceof Error && /storage is unavailable/.test(a.message))),
      'the failure is reported with its cause',
    );
  } finally {
    warn.mock.restore();
  }
});
