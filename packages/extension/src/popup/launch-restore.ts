/**
 * Which finished flows a relaunch must not reopen.
 *
 * The popup, a pop-out window and the desktop shell each restore the stored
 * route and wizard fields when they start (see `settleForLaunch` in
 * `@smirk/core`). This table names every wizard-backed flow that can sit on a
 * result screen, the routes that show it, and how its stored state says it
 * finished. A relaunch drops those and opens Home; anything still a draft or
 * still in flight (a send on Review, a Grin exchange waiting for its reply, a
 * swap waiting for its deposit) resumes as before.
 *
 * The tip composer and the pasted tip link claim keep their results in memory,
 * so they mark their own route with `router.markFinished` instead.
 */

import type { FinishedFlowRule, RouteController } from '@smirk/core';
import {
  GRIN_PASTE_INCOMING_WIZARD_ID,
  GRIN_PAY_INVOICE_WIZARD_ID,
  GRIN_REQUEST_WIZARD_ID,
  NONLOGS_WIZARD_ID,
  SEND_WIZARD_ID,
  THORCHAIN_WIZARD_ID,
  TROCADOR_WIZARD_ID,
  grinPasteIncomingDone,
  grinPayInvoiceDone,
  grinRequestDone,
  sendShowsReceipt,
  swapSettled,
} from '@smirk/ui';

export const FINISHED_FLOW_RULES: readonly FinishedFlowRule[] = [
  { wizardId: SEND_WIZARD_ID, routes: ['home/send'], finished: sendShowsReceipt },
  { wizardId: GRIN_REQUEST_WIZARD_ID, routes: ['home/receive/grin-request'], finished: grinRequestDone },
  { wizardId: GRIN_PASTE_INCOMING_WIZARD_ID, routes: ['home/receive/grin-incoming'], finished: grinPasteIncomingDone },
  { wizardId: GRIN_PAY_INVOICE_WIZARD_ID, routes: ['home/inbox/pay-invoice'], finished: grinPayInvoiceDone },
  // The Swap tab shows whichever provider's wizard is active.
  { wizardId: THORCHAIN_WIZARD_ID, routes: ['swap'], finished: swapSettled },
  { wizardId: NONLOGS_WIZARD_ID, routes: ['swap'], finished: swapSettled },
  { wizardId: TROCADOR_WIZARD_ID, routes: ['swap'], finished: swapSettled },
];

/**
 * Mark the result screen on `routeId` as finished, for a screen that holds its
 * result only in memory (the tip composer, a pasted tip link claim). A relaunch
 * then opens Home. The operation already succeeded, so a failed write is
 * logged and never surfaces as the operation's failure.
 */
export function markResultShown(router: Pick<RouteController, 'markFinished'>, routeId: string): void {
  void router.markFinished(routeId).catch((e: unknown) => {
    console.warn('[popup] could not mark a finished result screen:', e);
  });
}
