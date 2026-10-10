/**
 * LIVE: the history detail sheet for every send and every receive the send
 * spec made, on every coin, on both sides.
 *
 * Reads the run's spend ledger (written by b-send-receive.live.spec.ts in the
 * same run directory), so it runs after that spec; the lane config orders the
 * two projects. A coin with no recorded legs in this run skips and says so.
 * Nothing here spends: every check opens a sheet, reads it, holds it on
 * screen and closes it.
 *
 * For each payment:
 *   sender side: Sent, the amount, a fee under the cap, a time, a status,
 *     the full recipient address, the txid (Grin: kernel and slate), and the
 *     explorer action, which must open a page naming the transaction (served
 *     locally; no txid reaches a third party). On XMR and WOW the "Show
 *     transaction key" action is present and is never pressed: the key
 *     appears on video only in its masked state.
 *   recipient side: Received, the amount, the txid, a status, no recipient
 *     line and no key action.
 *   confirmations rising: the status now shows more confirmations than the
 *     sender saw right after broadcasting; for the first payment of each
 *     XMR/WOW run the spec also watches one more block land with the sheet
 *     held open (25 s holds while pending and after). Grin reports no count,
 *     so its status must have moved from pending to finalized.
 */

import { test, expect, LIVE_LANE, type LiveLane } from '../../fixtures/B-send-receive-history-wallets.js';
import {
  checkExplorer,
  closeDetail,
  confirmationsOf,
  expectMaskedTxKey,
  expectRecipientDetail,
  expectSenderDetail,
  openCoin,
  openDetail,
  POLL_MS,
  CHAIN_WAIT_MS,
  type Detail,
} from '../../fixtures/B-send-receive-history-flows.js';
import { LIVE_ASSETS, TICKER, fromAtomic, type LedgerEntry, type LiveAsset } from '../../fixtures/live-send.js';

/** Re-open a send until its confirmation count rises past `from`, holding each reading. */
async function watchOneMoreBlock(live: LiveLane, e: LedgerEntry, from: number): Promise<number> {
  const w = live.wallets[e.from];
  const deadline = Date.now() + CHAIN_WAIT_MS[e.asset];
  for (;;) {
    await w.footage.hold(POLL_MS, 'Waiting for the next block');
    await openCoin(live, w, e.asset);
    const d = await openDetail(w, { txid: e.txid! }, 'Open the send again');
    expect(d, 'the send is still listed').not.toBeNull();
    const now = confirmationsOf(d!.fields.Status) ?? 0;
    await w.footage.result('Confirmations after another block');
    await closeDetail(w);
    if (now > from) return now;
    if (Date.now() > deadline) throw new Error(`${TICKER[e.asset]} confirmations never rose`);
  }
}

function sentRef(e: LedgerEntry): { txid?: string; kernel?: string } {
  return e.asset === 'grin' ? { kernel: e.kernel! } : { txid: e.txid! };
}

async function senderSide(live: LiveLane, e: LedgerEntry, watchRise: boolean): Promise<void> {
  const w = live.wallets[e.from];
  const amountAtomic = BigInt(e.amountAtomic);
  const destination = e.asset === 'grin' ? undefined : live.book.get(e.to, e.asset);
  await openCoin(live, w, e.asset);
  const d: Detail | null = await openDetail(w, sentRef(e), 'Open the send');
  expect(d, `${e.from} lists the ${TICKER[e.asset]} send`).not.toBeNull();
  expectSenderDetail(e.asset, d!, {
    amountAtomic,
    ...(e.txid ? { txid: e.txid } : {}),
    ...(destination ? { destination } : {}),
  });
  if (e.asset === 'grin') {
    expect(d!.fields.Kernel, 'the sheet names the kernel').toBe(e.kernel);
    expect(d!.fields['Slate ID'], 'the sheet names the slate').toBeTruthy();
    expect(d!.fields.Status, 'the Grin send has gone out').toBe('finalized');
  } else {
    expect(d!.fields['Network fee'], 'the sender sees the fee').toBeTruthy();
    expectMaskedTxKey(e.asset, d!);
  }
  const now = confirmationsOf(d!.fields.Status);
  const first = confirmationsOf(e.firstStatus);
  if (e.asset !== 'grin') {
    // "Block #h" (no count) reads as null: at least one, and more than the
    // mempool state the sender saw at broadcast.
    const rose = now === null ? first !== null : first !== null && now > first;
    expect(rose, `${TICKER[e.asset]} confirmations rose since the broadcast`).toBe(true);
  }
  await w.footage.result('Send detail: amount, fee, time, confirmations, txid, recipient');
  await checkExplorer(w, e.asset === 'grin' ? e.kernel! : e.txid!);
  await w.footage.result('Back on the send detail');
  await closeDetail(w);
  if (watchRise && (e.asset === 'xmr' || e.asset === 'wow') && now !== null) {
    const later = await watchOneMoreBlock(live, e, now);
    live.progress(`${e.legId}: confirmations rose from ${now} to ${later} on camera`);
  }
}

async function recipientSide(live: LiveLane, e: LedgerEntry): Promise<void> {
  const w = live.wallets[e.to];
  const amountAtomic = BigInt(e.amountAtomic);
  await openCoin(live, w, e.asset);
  const d = await openDetail(
    w,
    e.asset === 'grin' ? { grinIncomingAmount: fromAtomic('grin', amountAtomic, 8) } : { txid: e.txid! },
    'Open the receive',
  );
  expect(d, `${e.to} lists the ${TICKER[e.asset]} receive`).not.toBeNull();
  expectRecipientDetail(e.asset, d!, { amountAtomic, ...(e.txid ? { txid: e.txid } : {}) });
  expect(d!.fields.Time, 'the receive has a time').toBeTruthy();
  if (e.asset !== 'grin') {
    expect(confirmationsOf(d!.fields.Status), 'the receive is confirmed').not.toBe(0);
  }
  await w.footage.result('Receive detail: amount, time, confirmations, txid');
  if (d!.hasExplorer) {
    await checkExplorer(w, e.asset === 'grin' ? (d!.fields.Kernel ?? '') : e.txid!);
  }
  await closeDetail(w);
}

if (LIVE_LANE) {
  test.describe('B live: history detail for every send and receive', () => {
    test.describe.configure({ timeout: 3 * 60 * 60_000 });

    for (const asset of LIVE_ASSETS) {
      test(`${TICKER[asset]}: every send and receive opens a complete detail sheet`, async ({ live }) => {
        const entries = live.ledger
          .entries(asset as LiveAsset)
          .filter((e) => e.status === 'broadcast' && (e.txid || e.kernel))
          .sort((a, b) => a.legId.localeCompare(b.legId));
        if (entries.length === 0) {
          const reason = `no ${TICKER[asset]} payments recorded in this run's ledger; run b-send-receive first`;
          live.progress(`skip: ${reason}`);
          test.skip(true, reason);
        }
        for (const [i, e] of entries.entries()) {
          await senderSide(live, e, i === 0);
          await recipientSide(live, e);
          live.progress(`${e.legId}: history detail checked on both sides`);
        }
      });
    }
  });
}
