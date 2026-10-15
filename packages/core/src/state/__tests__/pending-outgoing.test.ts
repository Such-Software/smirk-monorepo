/**
 * BTC/LTC in-flight spends stay out of available until the backend shows them.
 *
 * v0.3.1 rc e2e, 2026-10-15 (c-targeted-tips.live.spec.ts:393): a BTC tip's
 * funding tx was still unconfirmed 60 minutes after broadcast. Its
 * pendingOutgoing entry aged out on time alone, the backend's `confirmed`
 * still counted the spent inputs, and Home showed those coins as available
 * again. These tests pin the rule that replaced the timer: an entry leaves
 * when the backend's history says the tx was mined (or that it is gone), and
 * the display never deducts less than the backend's own mempool debit.
 *
 * The module is imported as a namespace so a missing export fails its own
 * tests rather than the whole file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as po from '../pending-outgoing';
import type { PendingOutgoingTx } from '../pending-outgoing';

const T0 = 1_760_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function entry(over: Partial<PendingOutgoingTx> = {}): PendingOutgoingTx {
  return {
    asset: 'btc',
    txHash: 'aa'.repeat(32),
    amount: '3000',
    fee: '154',
    recipient: 'bc1qexample',
    submittedAt: T0,
    inputs: [`${'11'.repeat(32)}:0`],
    ...over,
  };
}

const sent = (e: PendingOutgoingTx) => BigInt(e.amount) + BigInt(e.fee);

describe('a UTXO spend is not released by the clock alone', () => {
  for (const asset of ['btc', 'ltc']) {
    it(`${asset}: still deducted well past an hour when nothing says it was mined`, () => {
      const e = entry({ asset });
      for (const age of [61 * MIN, 3 * HOUR, 12 * HOUR]) {
        assert.equal(
          po.pendingOutgoingTotalWithFee([e], asset, T0 + age),
          sent(e),
          `released after ${age / MIN} min with no evidence`,
        );
      }
    });
  }

  it('a tx the backend still lists as unconfirmed survives reconcile at any age', () => {
    const e = entry();
    const history = [{ txid: e.txHash, height: 0 }];
    for (const age of [61 * MIN, 6 * HOUR, 30 * HOUR]) {
      const kept = po.reconcileUtxoPendingOutgoing([e], 'btc', history, T0 + age);
      assert.deepEqual(kept, [e], `dropped at ${age / MIN} min while still in the mempool`);
    }
  });

  it('the refresh reconcile keeps an hour-old unconfirmed spend deducted', () => {
    const e = entry();
    const now = T0 + 90 * MIN;
    const kept = po.reconcileAfterBalanceRefresh(
      [e],
      { btc: {} },
      { btc: [{ txid: e.txHash, height: 0 }] },
      now,
    );
    assert.equal(po.pendingOutgoingTotalWithFee(kept, 'btc', now), sent(e));
  });
});

describe('a UTXO entry leaves once the backend reflects the outcome', () => {
  it('drops the entry as soon as history lists the tx as mined, so it is not subtracted twice', () => {
    const e = entry();
    const kept = po.reconcileUtxoPendingOutgoing([e], 'btc', [{ txid: e.txHash, height: 900_001 }], T0 + 5 * MIN);
    assert.equal(kept.length, 0);
  });

  it('matches txids regardless of hex case and tolerates a tx listed once per address', () => {
    const e = entry({ txHash: 'AB'.repeat(32) });
    const history = [
      { txid: 'ab'.repeat(32), height: 0 },
      { txid: 'ab'.repeat(32), height: 900_002 },
    ];
    assert.equal(po.reconcileUtxoPendingOutgoing([e], 'btc', history, T0 + MIN).length, 0);
  });

  it('a tx the backend has stopped listing clears after the grace window (dropped or replaced)', () => {
    const e = entry();
    const grace = po.UTXO_UNLISTED_GRACE_MS;
    assert.ok(typeof grace === 'number' && grace > 0);
    const other = [{ txid: 'ff'.repeat(32), height: 900_000 }];
    assert.equal(po.reconcileUtxoPendingOutgoing([e], 'btc', other, T0 + grace / 2).length, 1, 'indexer lag is tolerated');
    assert.equal(po.reconcileUtxoPendingOutgoing([e], 'btc', other, T0 + grace).length, 0);
    assert.equal(po.reconcileUtxoPendingOutgoing([e], 'btc', [], T0 + grace + MIN).length, 0);
  });

  it('an unreadable history is unknown: the entry stays until the long backstop', () => {
    const e = entry();
    const at = (age: number) => po.reconcileAfterBalanceRefresh([e], {}, { btc: null }, T0 + age);
    assert.equal(at(6 * HOUR).length, 1);
    assert.equal(at(48 * HOUR).length, 0, 'a lost entry still clears eventually');
  });

  it('only touches the asset whose history was read', () => {
    const btc = entry();
    const ltc = entry({ asset: 'ltc', txHash: 'cc'.repeat(32) });
    const kept = po.reconcileUtxoPendingOutgoing([btc, ltc], 'btc', [{ txid: btc.txHash, height: 1 }], T0 + MIN);
    assert.deepEqual(kept, [ltc]);
  });
});

describe('displayed BTC/LTC available never includes a spend the backend sees in the mempool', () => {
  it('deducts the backend mempool debit when the entry is gone', () => {
    // Made on another device, or past the backstop: no entry, but the
    // backend's signed unconfirmed still shows the coins leaving.
    assert.equal(po.utxoAvailableDeduction([], 'btc', -6308n, T0), 6308n);
  });

  it('does not deduct the same spend twice when both sides know about it', () => {
    const e = entry();
    assert.equal(po.utxoAvailableDeduction([e], 'btc', -sent(e), T0 + MIN), sent(e));
  });

  it('deducts the local entry while the backend has not seen the broadcast yet', () => {
    const e = entry();
    assert.equal(po.utxoAvailableDeduction([e], 'btc', 0n, T0 + MIN), sent(e));
    // Incoming unconfirmed funds are shown as pending elsewhere; they never
    // offset an in-flight spend.
    assert.equal(po.utxoAvailableDeduction([e], 'btc', 50_000n, T0 + MIN), sent(e));
  });
});

describe('CryptoNote reconcile is unchanged', () => {
  it('XMR entries still drop on verified key images and age out at their own window', () => {
    const ki = 'de'.repeat(32);
    const x = entry({ asset: 'xmr', inputs: [ki], txHash: 'ee'.repeat(32) });
    assert.equal(po.reconcileAfterBalanceRefresh([x], { xmr: { verifiedSpentInputs: [ki] } }, {}, T0 + MIN).length, 0);
    assert.equal(po.reconcileAfterBalanceRefresh([x], { xmr: {} }, {}, T0 + MIN).length, 1);
    assert.equal(po.reconcileAfterBalanceRefresh([x], { xmr: {} }, {}, T0 + 2 * HOUR).length, 0);
  });
});
