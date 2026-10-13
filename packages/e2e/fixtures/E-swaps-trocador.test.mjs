// Guards of the real Trocador swap in the E-swaps live lane.
// Run: node --test packages/e2e/fixtures/E-swaps-trocador.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TROCADOR_LTC_HARD_MAX,
  TROCADOR_SWAP_DECISION,
  ltcAtomic,
  trocadorAmountRefusal,
  trocadorEvidence,
  trocadorPlan,
  trocadorSwapRefusal,
} from './E-swaps-trocador.mjs';

test('the real swap runs only on the owner explicit yes', () => {
  assert.equal(trocadorSwapRefusal({ [TROCADOR_SWAP_DECISION]: 'yes' }), null);
  assert.equal(trocadorSwapRefusal({ [TROCADOR_SWAP_DECISION]: ' YES ' }), null);
  for (const env of [{}, { [TROCADOR_SWAP_DECISION]: '' }, { [TROCADOR_SWAP_DECISION]: 'no' }, { [TROCADOR_SWAP_DECISION]: '1' }, { [TROCADOR_SWAP_DECISION]: 'true' }, { E2E_LIVE_MONEY: '1' }]) {
    const reason = trocadorSwapRefusal(env);
    assert.ok(reason, `refused for ${JSON.stringify(env)}`);
    assert.ok(reason.includes(TROCADOR_SWAP_DECISION), 'the refusal names the decision');
  }
  // An odd value is never echoed back.
  assert.ok(!trocadorSwapRefusal({ [TROCADOR_SWAP_DECISION]: 'sure-why-not' }).includes('sure-why-not'));
});

test('the default plan tries rising amounts from 0.1 LTC, all within the cap', () => {
  const { ladder, capAtomic } = trocadorPlan({});
  assert.ok(ladder.length >= 2);
  assert.equal(ladder[0].atomic, ltcAtomic('0.1'));
  for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i].atomic > ladder[i - 1].atomic);
  assert.ok(ladder.every((s) => s.atomic <= capAtomic));
  assert.ok(capAtomic <= ltcAtomic(TROCADOR_LTC_HARD_MAX));
});

test('a cap above the hard maximum, a step above the cap, or a malformed plan refuses', () => {
  assert.throws(() => trocadorPlan({ E_SWAPS_TROCADOR_LTC_CAP: '0.6' }), /hard maximum/);
  assert.throws(() => trocadorPlan({ E_SWAPS_TROCADOR_LTC_CAP: '100' }), /hard maximum/);
  assert.throws(() => trocadorPlan({ E_SWAPS_TROCADOR_LTC_CAP: '0.2', E_SWAPS_TROCADOR_LTC_LADDER: '0.1,0.25' }), /above the cap/);
  assert.throws(() => trocadorPlan({ E_SWAPS_TROCADOR_LTC_LADDER: '0.2,0.1' }), /rise/);
  assert.throws(() => trocadorPlan({ E_SWAPS_TROCADOR_LTC_LADDER: '0.1,abc' }), /step 2/);
  assert.throws(() => trocadorPlan({ E_SWAPS_TROCADOR_LTC_LADDER: '0' }), /above zero/);
  assert.throws(() => trocadorPlan({ E_SWAPS_TROCADOR_LTC_LADDER: ' , ' }), /no amount/);
  assert.throws(() => trocadorPlan({ E_SWAPS_TROCADOR_LTC_CAP: '-1' }));
  assert.throws(() => trocadorPlan({ E_SWAPS_TROCADOR_LTC_CAP: '0.1e1' }));
  // The hard maximum itself is allowed, and a lower cap narrows the plan.
  assert.equal(trocadorPlan({ E_SWAPS_TROCADOR_LTC_CAP: TROCADOR_LTC_HARD_MAX, E_SWAPS_TROCADOR_LTC_LADDER: '0.1,0.5' }).ladder.length, 2);
  assert.equal(trocadorPlan({ E_SWAPS_TROCADOR_LTC_CAP: '0.15', E_SWAPS_TROCADOR_LTC_LADDER: '0.1,0.15' }).capAtomic, ltcAtomic('0.15'));
});

test('a deposit above the cap is refused before Send, whatever the provider asked for', () => {
  const { capAtomic } = trocadorPlan({});
  assert.equal(trocadorAmountRefusal(ltcAtomic('0.1'), capAtomic), null);
  assert.equal(trocadorAmountRefusal(capAtomic, capAtomic), null);
  assert.ok(trocadorAmountRefusal(capAtomic + 1n, capAtomic));
  assert.ok(trocadorAmountRefusal(ltcAtomic('2.5'), capAtomic));
  assert.ok(trocadorAmountRefusal(0n, capAtomic));
  assert.ok(trocadorAmountRefusal(ltcAtomic('0.1'), ltcAtomic('5')), 'a cap above the hard maximum is refused here too');
  assert.ok(trocadorAmountRefusal(Number.NaN, capAtomic));
});

test('the evidence record keeps public facts only and never a link, token or phrase', () => {
  const secretLink = 'https://trocador.app/en/checkout?id=Ab12Cd34&token=f00dfeedf00dfeedf00dfeed';
  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const record = trocadorEvidence({
    tradeId: 'Ab12Cd34Ef',
    exchange: 'FixedFloat',
    depositLtc: '0.15',
    depositTxid: 'ab'.repeat(32),
    finalStatus: 'completed',
    completedXmrAtomic: '123456789012',
    xmrRiseAtomic: '123000000000',
    statusUrl: secretLink,
    webhookToken: 'f00dfeedf00dfeedf00dfeed',
    phrase,
  });
  assert.deepEqual(Object.keys(record).sort(), ['completedXmrAtomic', 'depositLtc', 'depositTxid', 'exchange', 'finalStatus', 'tradeId', 'xmrRiseAtomic']);
  const text = JSON.stringify(record);
  for (const secret of [secretLink, 'f00dfeedf00dfeed', 'abandon ability']) assert.ok(!text.includes(secret));

  // A secret smuggled into a known field is withheld, not written.
  const smuggled = trocadorEvidence({ tradeId: secretLink, exchange: phrase, depositTxid: 'not-a-txid', finalStatus: 'completed; token=x' });
  const smuggledText = JSON.stringify(smuggled);
  for (const secret of [secretLink, 'abandon ability', 'token=x']) assert.ok(!smuggledText.includes(secret));
  assert.ok(Object.values(smuggled).every((v) => v.startsWith('withheld')));
  // A THORChain id is not a Trocador trade id.
  assert.ok(trocadorEvidence({ tradeId: 'thorchain:ABCDEF0123' }).tradeId.startsWith('withheld'));
});
