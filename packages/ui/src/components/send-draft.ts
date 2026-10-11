import type { WizardState } from '@smirk/core';

/** Session-state id of the Send wizard. */
export const SEND_WIZARD_ID = 'send';

/** Send's receipt step. Send reaches it only after the broadcast or Grin finalize succeeded. */
export const SEND_RECEIPT_STEP = 4;

/** True when a persisted send shows its receipt: the money already left, nothing to resume. */
export function sendShowsReceipt(current: WizardState): boolean {
  return current.step >= SEND_RECEIPT_STEP;
}

/** Open Send using persisted state, before rendering a restored receipt or draft. */
export function prepareSendDraft(current: WizardState, initialAssetId?: string): WizardState {
  const draft = sendShowsReceipt(current)
    ? { step: 0, fields: {}, startedAt: Date.now() }
    : current;
  // Preserve a recipient, amount or interactive exchange already in progress.
  // An empty chooser is safe to initialize from the selected coin screen.
  if (initialAssetId && draft.step === 0 && !draft.fields.toAddress &&
      !draft.fields.amountText && !draft.fields.grinSlateId) {
    const fields = draft.fields.fromAssetId === initialAssetId ? draft.fields : {};
    return { ...draft, step: 1, fields: { ...fields, fromAssetId: initialAssetId } };
  }
  return draft;
}
