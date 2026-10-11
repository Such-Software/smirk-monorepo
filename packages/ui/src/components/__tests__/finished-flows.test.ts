/**
 * How each wizard's stored state says its flow finished. A relaunch drops a
 * finished flow and opens Home (see `stateForLaunch` in @smirk/core), so every
 * answer of "finished" here must mean nothing is left to resume.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStorage, SessionStateStore, Wizard, type WizardState } from '@smirk/core';
import type { SwapInFlight } from '../SwapTab';
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
} from '../../index';

const PREDICATES: Array<[string, (w: WizardState) => boolean]> = [
  [SEND_WIZARD_ID, sendShowsReceipt],
  [GRIN_REQUEST_WIZARD_ID, grinRequestDone],
  [GRIN_PASTE_INCOMING_WIZARD_ID, grinPasteIncomingDone],
  [GRIN_PAY_INVOICE_WIZARD_ID, grinPayInvoiceDone],
  [TROCADOR_WIZARD_ID, swapSettled],
  [THORCHAIN_WIZARD_ID, swapSettled],
  [NONLOGS_WIZARD_ID, swapSettled],
];

function at(step: number, fields: Record<string, unknown> = {}): WizardState {
  return { step, fields, startedAt: 1 };
}

function swapIn(state: SwapInFlight['state']): WizardState {
  const inFlight: SwapInFlight = {
    id: 'trade-1',
    fromAsset: 'btc',
    toAsset: 'ltc',
    fromAmountAtomic: '23000',
    toAmountEstimateAtomic: '1000000',
    depositAddress: 'deposit',
    state,
  };
  return at(0, { step: 3, inFlight });
}

test('a wizard that was just opened is never finished', async () => {
  for (const [id, finished] of PREDICATES) {
    const store = new SessionStateStore(new InMemoryStorage());
    const opened = await new Wizard(store, id, id.startsWith('swap-') ? { step: 0 } : {}).start();
    assert.equal(finished(opened), false, id);
    store.destroy();
  }
});

test('Send resumes up to Review and is finished only on its receipt', () => {
  const review = at(3, { fromAssetId: 'btc', toAddress: 'destination', amountText: '0.001', feeTier: 'normal' });
  assert.equal(sendShowsReceipt(review), false, 'a send awaiting broadcast must resume');
  const grinExchange = at(3, { fromAssetId: 'grin', toAddress: 'npub', amountText: '1', grinSlateId: 'slate' });
  assert.equal(sendShowsReceipt(grinExchange), false, 'a Grin send waiting for its reply must resume');
  assert.equal(sendShowsReceipt(at(4, { fromAssetId: 'btc', lastTxid: 'txid' })), true);
});

test('Grin exchanges resume until their Done screen', () => {
  assert.equal(grinRequestDone(at(1, { armoredOutgoing: 'I1', slateId: 'slate' })), false);
  assert.equal(grinRequestDone(at(2, { lastKernelExcessHex: 'kernel' })), true);
  assert.equal(grinPasteIncomingDone(at(1, { armoredIncoming: 'S1' })), false);
  assert.equal(grinPasteIncomingDone(at(2)), true);
  assert.equal(grinPayInvoiceDone(at(1, { armoredIncoming: 'I1' })), false);
  assert.equal(grinPayInvoiceDone(at(2, { armoredIncoming: 'I1' })), false, 'the reply is still on screen to copy');
  assert.equal(grinPayInvoiceDone(at(3)), true);
});

test('a swap resumes until its provider settles it', () => {
  for (const reason of ['awaiting_deposit', 'awaiting_confirmations', 'in_progress'] as const) {
    assert.equal(swapSettled(swapIn({ state: 'pending', reason })), false, reason);
  }
  assert.equal(
    swapSettled(swapIn({ state: 'failed', reason: 'If you deposited, funds will be returned' })),
    false,
    'a failed swap may still have a refund on its way',
  );
  assert.equal(swapSettled(swapIn({ state: 'completed', outboundTxId: 'out', toAmount: '1' })), true);
  assert.equal(swapSettled(swapIn({ state: 'refunded', refundTxId: 'back', reason: 'refunded' })), true);
});

test('swap fields that do not read as a settled swap are not settled', () => {
  assert.equal(swapSettled(at(0, { step: 1 })), false);
  assert.equal(swapSettled(at(0, { step: 2, inFlight: 'unexpected' })), false);
  assert.equal(swapSettled(at(0, { step: 2, inFlight: { id: 'trade-1' } })), false);
  assert.equal(swapSettled(at(0, { step: 2, inFlight: { state: { state: 'finished' } } })), false);
});
