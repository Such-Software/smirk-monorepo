import type { WizardState } from '@smirk/core';

/** Open Send using persisted state, before rendering a restored receipt or draft. */
export function prepareSendDraft(current: WizardState, initialAssetId?: string): WizardState {
  const draft = current.step >= 4
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
