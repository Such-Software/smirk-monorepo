/**
 * Opening Send on a draft another screen prepared: the Swap tab's deposit
 * (swap-handoff.ts) or a GoblinPay pay link pasted in Inbox.
 *
 * The draft and the route are one store update, so no reader of storage
 * (another window, the next launch after the popup closed) ever sees half of
 * a handoff: Send is either untouched or open on the draft.
 *
 * Send's own state is protected. A draft in progress is replaced only when
 * the user agrees. A Grin payment waiting for the recipient's reply is never
 * replaced: its sender context exists only in Send's fields, so replacing it
 * would leave the reply impossible to finalize. Send's own Cancel is the way
 * out of that exchange, and it also releases the reserved inputs.
 */
import type { GoblinPayRequest, SessionStateStore, WizardState } from '@smirk/core';
import { SEND_WIZARD_ID, sendShowsReceipt } from '@smirk/ui';

/** The route Send renders on. */
export const SEND_ROUTE = 'home/send';

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

/**
 * True when Send holds a Grin payment it built and is waiting to finalize: the
 * slate went to the recipient and their reply can only be finalized with the
 * sender context kept in Send. Send's Cancel clears both fields.
 */
export function sendGrinExchangeInFlight(send: WizardState | undefined): boolean {
  if (!send || sendShowsReceipt(send)) return false;
  const f = send.fields as { grinSlateId?: string; grinSenderContextJson?: string };
  return !!f.grinSlateId || !!f.grinSenderContextJson;
}

/** What became of a request to open Send on a prepared draft. */
export interface SendHandoff {
  /** Send is open on the draft. */
  opened: boolean;
  /** Why Send was not opened, when it was not the user declining to replace a draft. */
  refusal?: string;
}

function grinExchangeRefusal(what: string): string {
  return (
    `Send is waiting for the reply to a Grin payment you started, and replacing it would lose that payment. ` +
    `Finish it, or cancel it in Send, before opening ${what}.`
  );
}

/** Thrown inside the store update so that nothing is written. */
class SendChanged extends Error {}

/**
 * Open Send on `draft`, described to the user as `what` ("this swap deposit").
 * A Grin payment waiting for its reply is refused; a draft in progress is
 * replaced only when `confirmReplace` agrees. Both are checked again inside
 * the write, against the state the write replaces, so a Send changed since
 * the question (another window, a queued write) is never overwritten.
 */
export async function openSendOnDraft(
  store: SessionStateStore,
  draft: WizardState,
  what: string,
  confirmReplace: (question: string) => boolean,
): Promise<SendHandoff> {
  const before = (await store.load()).wizards[SEND_WIZARD_ID];
  if (sendGrinExchangeInFlight(before)) return { opened: false, refusal: grinExchangeRefusal(what) };
  const asked = sendDraftInProgress(before);
  if (asked && !confirmReplace(`You have a Send draft in progress. Replace it with ${what}?`)) {
    return { opened: false };
  }
  try {
    await store.update((s) => {
      const now = s.wizards[SEND_WIZARD_ID];
      if (sendGrinExchangeInFlight(now)) throw new SendChanged(grinExchangeRefusal(what));
      if (!asked && sendDraftInProgress(now)) {
        throw new SendChanged(`Send changed while ${what} was opening. Nothing was replaced; try again.`);
      }
      s.wizards[SEND_WIZARD_ID] = draft;
      s.route = { current: SEND_ROUTE };
    });
  } catch (e) {
    if (e instanceof SendChanged) return { opened: false, refusal: e.message };
    throw e;
  }
  return { opened: true };
}

/** Send's address step for a GoblinPay pay link: Grin to the link's recipient, with its amount and memo. */
export function payLinkSendDraft(pay: GoblinPayRequest, now: number = Date.now()): WizardState {
  return {
    step: 1,
    startedAt: now,
    fields: {
      fromAssetId: 'grin',
      toAddress: pay.recipientPubkeyHex,
      ...(pay.amountGrin ? { amountText: pay.amountGrin } : {}),
      ...(pay.memo ? { grinPayMemo: pay.memo } : {}),
    },
  };
}

/** Inbox's paste of a pay link: open Send on it, or say why not. */
export async function openPayLinkInSend(
  store: SessionStateStore,
  pay: GoblinPayRequest,
  confirmReplace: (question: string) => boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const handoff = await openSendOnDraft(store, payLinkSendDraft(pay), 'this pay link', confirmReplace);
  if (handoff.opened) return { ok: true };
  return { ok: false, error: handoff.refusal ?? 'Kept your Send draft. The pay link was not opened.' };
}
