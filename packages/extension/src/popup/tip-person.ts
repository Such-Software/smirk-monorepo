/**
 * The last step of a person tip: hand the funded tip's claim key to the
 * recipient's npub. Kept apart from tip-handler.ts (which pulls in the WASM
 * signer) so this policy is unit-tested on its own.
 */
import type { NpubTipDelivery } from '@smirk/core';
import type { TipSubmitFields, TipSubmitOutcome } from '@smirk/ui';

export type DeliverPersonTip = (
  recipientPubkeyHex: string,
  tip: NpubTipDelivery,
) => Promise<{ selfCopy: boolean }>;

/**
 * Deliver a funded tip to `fields.recipient`. The funds have already left the
 * wallet, so a delivery failure never turns into `ok: false`: it becomes a
 * warning, and the share link is the fallback the sender can forward.
 */
export async function deliverPersonTipOutcome(
  outcome: Extract<TipSubmitOutcome, { ok: true }>,
  fields: TipSubmitFields,
  deliver: DeliverPersonTip | undefined,
): Promise<TipSubmitOutcome> {
  const recipient = fields.recipient;
  if (!recipient) return outcome;
  const claimKey = outcome.shareUrl?.split('#')[1];
  const fallback = 'Send them the link from Tips, sent, so they can still claim it.';
  if (!claimKey || !deliver) {
    return {
      ...outcome,
      deliveryWarning: `The tip is funded, but it could not be delivered to ${recipient.display}. ${fallback}`,
    };
  }
  try {
    await deliver(recipient.pubkeyHex, {
      tipId: outcome.tipId,
      claimKey,
      asset: fields.assetId,
      amount: Number(fields.amountAtomic),
      ...(fields.memo ? { memo: fields.memo } : {}),
      ...(fields.expiresAt ? { expiresAt: fields.expiresAt } : {}),
    });
    return { ...outcome, deliveredTo: recipient.display };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      ...outcome,
      deliveryWarning: `The tip is funded, but delivery to ${recipient.display} failed (${why}). ${fallback}`,
    };
  }
}
