/**
 * The Swap tab's "Open Send → pre-filled": hand a swap's deposit to Send.
 *
 * Send must open on Compose holding the deposit's coin, address and exact
 * amount, never on its coin chooser. The handler used to save the Send draft
 * and then navigate in a second save; whenever the store lost one of the two
 * (the storage echo fixed in session-state.ts), Send opened on "Send what?"
 * with nothing filled in, or did not open at all. The draft and the route are
 * now one save (send-handoff.ts): Send never mounts without its deposit, and
 * storage never holds half a handoff.
 *
 * The handler tells the Swap tab whether Send opened. The tab moves the swap
 * to its status step only then: that step has no pay action and no way back,
 * so a swap moved there with Send closed could no longer be paid from here.
 */
import type { SessionStateStore, WizardState } from '@smirk/core';
import type { SwapInFlight } from '@smirk/ui';
import { atomicToText } from './format';
import { openSendOnDraft, type SendHandoff } from './send-handoff';

/** Send's Compose step: the coin and the recipient are already chosen. */
const SEND_COMPOSE_STEP = 2;

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
 * Open Send on `deposit`, in one store update. A Send draft in progress is
 * replaced only when `confirmReplace` agrees, and a Grin payment waiting for
 * its reply never is (send-handoff.ts).
 */
export function openSwapDepositInSend(
  store: SessionStateStore,
  deposit: SwapInFlight,
  confirmReplace: (question: string) => boolean,
): Promise<SendHandoff> {
  return openSendOnDraft(store, swapDepositDraft(deposit), 'this swap deposit', confirmReplace);
}

/** How the popup asks and tells: `window.confirm` and `window.alert`, injected for tests. */
export interface HandoffDialogs {
  confirm(question: string): boolean;
  alert(message: string): void;
}

/**
 * The Swap tab's `onOpenSend`: resolves true only when Send opened on the
 * deposit. A refusal is shown before it resolves false; a declined replace
 * needs no message, since the user just answered it.
 */
export function swapOpenSendHandler(
  store: SessionStateStore,
  dialogs: HandoffDialogs,
): (deposit: SwapInFlight) => Promise<boolean> {
  return async (deposit) => {
    const handoff = await openSwapDepositInSend(store, deposit, (question) => dialogs.confirm(question));
    if (handoff.refusal) dialogs.alert(handoff.refusal);
    return handoff.opened;
  };
}
