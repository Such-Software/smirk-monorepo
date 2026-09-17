import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRIN_VOUCHER_VERSION,
  decodeGrinVoucher,
  encodeGrinVoucher,
  type GrinVoucher,
} from '../grin-voucher';

const VOUCHER: GrinVoucher = {
  commit: '08' + 'ab'.repeat(32),
  proof: 'cd'.repeat(337),
  features: 0,
  blind: 'ef'.repeat(32),
  amount: 12_500_000n,
};

function jsonOf(v: GrinVoucher): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(encodeGrinVoucher(v)));
}

test('a voucher round-trips through the wire format', () => {
  assert.deepEqual(decodeGrinVoucher(encodeGrinVoucher(VOUCHER)), VOUCHER);
});

test('the format tags its own version', () => {
  assert.equal(jsonOf(VOUCHER).grinvch, GRIN_VOUCHER_VERSION);
});

test('an amount too large for a double survives the round trip', () => {
  // The whole reason amount is a string. A u64 nanogrin value past 2^53 is
  // what a JSON number silently rounds, and a rounded blinding-factor amount
  // does not sweep: the commitment will not balance.
  const huge = 2n ** 63n - 1n;
  const decoded = decodeGrinVoucher(encodeGrinVoucher({ ...VOUCHER, amount: huge }));
  assert.equal(decoded.amount, huge);
  assert.notEqual(decoded.amount, BigInt(Number(huge)));
});

test('the amount is written as a decimal string, not a number', () => {
  assert.equal(typeof jsonOf(VOUCHER).amount, 'string');
});

test("the sender's child index is not carried", () => {
  // It was never needed to sweep, and it identifies which output of the
  // sender's wallet paid.
  const keys = Object.keys(jsonOf(VOUCHER));
  assert.ok(!keys.some((k) => /child/i.test(k)), `voucher leaks a child index: ${keys}`);
});

test('a legacy untagged voucher still decodes', () => {
  // Senders of these are gone; the recipient must still be able to claim.
  const legacy = new TextEncoder().encode(
    JSON.stringify({
      blindingFactor: VOUCHER.blind,
      commitment: VOUCHER.commit,
      proof: VOUCHER.proof,
      nChild: 4,
      amount: Number(VOUCHER.amount),
      features: 0,
    }),
  );
  assert.deepEqual(decodeGrinVoucher(legacy), VOUCHER);
});

test('a voucher missing spend authority is refused, not silently emptied', () => {
  for (const drop of ['commit', 'blind', 'proof'] as const) {
    const body = jsonOf(VOUCHER);
    delete body[drop];
    assert.throws(
      () => decodeGrinVoucher(new TextEncoder().encode(JSON.stringify(body))),
      new RegExp(drop, 'i'),
      `dropping ${drop} produced a voucher instead of an error`,
    );
  }
});

test('a lossy amount is reported rather than rounded', () => {
  for (const amount of [1.5, Number.MAX_SAFE_INTEGER + 2, -1]) {
    const body = { ...jsonOf(VOUCHER), amount };
    assert.throws(() => decodeGrinVoucher(new TextEncoder().encode(JSON.stringify(body))));
  }
});

test('a future format version is refused rather than misread', () => {
  const body = { ...jsonOf(VOUCHER), grinvch: GRIN_VOUCHER_VERSION + 1 };
  assert.throws(
    () => decodeGrinVoucher(new TextEncoder().encode(JSON.stringify(body))),
    /newer than this wallet/,
  );
});
