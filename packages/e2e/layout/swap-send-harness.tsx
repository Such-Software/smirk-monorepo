/**
 * The Swap to Send handoff on a real extension page: the popup's real
 * SwapRouter (SwapTab, THORChain client, its Open Send handler) and the real
 * SendWizard, sharing the popup's real state store over the browser's own
 * `chrome.storage.local`. swap-send-handoff.spec.ts loads this as an unpacked
 * extension, because the defect it guards lives in how that storage reports a
 * page's own writes back to it, which no in-page stand-in reproduces.
 *
 * Nothing here signs or broadcasts. The Send step's submit runs the popup's
 * own memo-deposit check (checkMemoDeposit), records what would have been
 * signed on `window.__submitted`, and returns a refusal.
 */
import { h, render } from 'preact';
import { SendWizard, StateProvider, useRoute, type SendSubmitResult } from '@smirk/ui';
import type { PendingOutgoingContext } from '@smirk/core';
import { store, router } from '../../extension/src/popup/singletons';
import { SwapRouter } from '../../extension/src/popup/routes/swap';
import { checkMemoDeposit } from '../../extension/src/popup/thorchain';
import { parseAmount } from '../../extension/src/popup/format';

export interface SubmittedDeposit {
  fromAssetId: string;
  toAddress: string;
  amountAtomic: string;
  decision: string;
  memo?: string;
}

declare global {
  interface Window {
    __mounted: boolean;
    __submitted: SubmittedDeposit[];
  }
}

window.__submitted = [];

// Public receive addresses only, all synthetic (the recorded fixture's
// destinations). No keys: the send journal is off without them.
const wallet = {
  addresses: {
    btc: 'bc1qjc86s9s508ttkryzsk35agghhv664a6an5eclv',
    ltc: 'ltc1qp6r3vr50h7ehdq5qw2k8alzqwjq76xd5ux38mz',
  },
  keys: {},
} as never;

/** Confirmed balances the Send step sees, in atomic units. */
const BALANCES: Record<string, bigint> = { btc: 39_841n, ltc: 50_000_000n };

function Shell() {
  const { route, navigate } = useRoute();
  if (route.current === 'home/send') {
    return h(SendWizard, {
      assetIds: ['btc', 'ltc'],
      validateAddress: () => null,
      parseAmount,
      resolveBalance: (assetId: string) => BALANCES[assetId] ?? 0n,
      resolveFeeRates: async () => ({ fast: 6, normal: 4, slow: 2 }),
      onSubmit: async (fields): Promise<SendSubmitResult> => {
        const saved = (await store.load()).wizards.send?.fields as
          | { pendingContext?: PendingOutgoingContext; pendingContextSeed?: { fromAssetId?: string; toAddress?: string } }
          | undefined;
        const check = await checkMemoDeposit({
          ctx: saved?.pendingContext,
          seed: saved?.pendingContextSeed,
          fields: { ...fields },
        });
        window.__submitted.push({
          fromAssetId: fields.fromAssetId,
          toAddress: fields.toAddress,
          amountAtomic: fields.amountAtomic.toString(),
          decision: check.kind,
          ...(check.kind === 'send-with-memo' ? { memo: check.memo } : {}),
        });
        return { ok: false, error: 'Harness: nothing is signed.' };
      },
      onExit: () => void navigate('swap'),
    });
  }
  return h(SwapRouter, { wallet, session: null });
}

void (async () => {
  await router.navigate('swap');
  render(h(StateProvider, { store, router, children: h(Shell, {}) }), document.getElementById('root')!);
  window.__mounted = true;
})();
