/**
 * The Swap tab's "Open Send → pre-filled": hand a swap's deposit to Send.
 *
 * Send must open on Compose holding the deposit's coin, address and exact
 * amount, never on its coin chooser. The handler used to save the Send draft
 * and then navigate in a second save; whenever the store lost one of the two
 * (the storage echo fixed in session-state.ts, or another window saving in
 * between), Send opened on "Send what?" with nothing filled in, or did not
 * open at all. The draft and the route are now one save: Send never mounts
 * without its deposit.
 */
import type { SessionStateStore, WizardState } from '@smirk/core';
import { SEND_WIZARD_ID, sendShowsReceipt, type SwapInFlight } from '@smirk/ui';
import { atomicToText } from './format';

/** The route Send renders on. */
export const SEND_ROUTE = 'home/send';

/** Send's Compose step: the coin and the recipient are already chosen. */
const SEND_COMPOSE_STEP = 2;

/**
 * True when Send holds something the user typed or chose: a recipient, an
 * amount, or a coin past the chooser. An empty chooser left from an earlier
 * visit is not a draft, and neither is a finished send's receipt.
 */
export function sendDraftInProgress(send: WizardState | undefined): boolean {
  if (!send || sendShowsReceipt(send)) return false;
  const f = send.fields as { fromAssetId?: string; toAddress?: string; amountText?: string };
  return !!f.toAddress || !!f.amountText || (!!f.fromAssetId && send.step > 0);
}

/** The Send wizard state that pays `deposit`: Compose, with nothing left from an earlier draft. */
export function swapDepositDraft(deposit: SwapInFlight, now: number = Date.now()): WizardState {
  return {
    step: SEND_COMPOSE_STEP,
    startedAt: now,
    fields: {
      fromAssetId: deposit.fromAsset,
      toAddress: deposit.depositAddress,
      amountText: atomicToText(deposit.fromAmountAtomic, deposit.fromAsset),
      // Tags the resulting pending send as this swap's deposit, so its
      // Activity row reads "Swap deposit → LTC" and links back to the swap.
      pendingContext: {
        kind: 'swap-deposit',
        tradeId: deposit.id,
        toAsset: deposit.toAsset,
        provider: deposit.provider ?? 'trocador',
        // THORChain: the send path refuses this vault unless the memo, the
        // quoted amount and the deadline all still hold.
        ...(deposit.memo
          ? {
              memo: deposit.memo,
              amountAtomic: deposit.fromAmountAtomic,
              ...(deposit.depositBeforeMs !== undefined ? { depositBeforeMs: deposit.depositBeforeMs } : {}),
            }
          : {}),
      },
      // The prefill as handed over. The submit path drops the swap context
      // when the user changed the coin or the address since.
      pendingContextSeed: {
        fromAssetId: deposit.fromAsset,
        toAddress: deposit.depositAddress,
      },
    },
  };
}

/**
 * Open Send on `deposit`. A Send draft in progress is replaced only when
 * `confirmReplace` agrees; otherwise nothing is written and this returns
 * false. The draft and the route are written in one store update.
 */
export async function openSwapDepositInSend(
  store: SessionStateStore,
  deposit: SwapInFlight,
  confirmReplace: () => boolean,
): Promise<boolean> {
  const current = await store.load();
  if (sendDraftInProgress(current.wizards[SEND_WIZARD_ID]) && !confirmReplace()) return false;
  await store.update((s) => {
    s.wizards[SEND_WIZARD_ID] = swapDepositDraft(deposit);
    s.route = { current: SEND_ROUTE };
  });
  return true;
}
