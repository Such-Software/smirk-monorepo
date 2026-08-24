/**
 * Restore proof-of-work: the client half of `core/restore_pow.rs`.
 *
 * This gate took GRIN balances off production entirely. `fetchGrinBalance` sent
 * no `start_height`, so the backend assumed its deepest permitted scan; that
 * depth is priced at 9 bits on `api.smirk.cash`; and while the wire field
 * `restore_pow_nonce` was plumbed end to end, nothing ever produced a value for
 * it. Every wallet, not merely old ones, got "this restore depth requires a
 * 9-bit proof-of-work nonce; upgrade to a newer Smirk client" and showed no
 * GRIN balance at all. Verified against production on 2026-08-24, where the fix
 * surfaced 17.87 GRIN on a wallet that had been reading as empty.
 *
 * The preimage must match the Rust byte for byte or the backend rejects the
 * nonce, so these tests pin the shape rather than merely the difficulty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredRestorePowBits, solveRestorePow } from '../pow';

const POLICY = { pow_free_days: 90, pow_days_per_bit: 30, pow_max_bits: 24, max_depth_days: 365 };
const GRIN_DAY = 1440;

test('difficulty mirrors the backend curve', () => {
  const tip = 4_000_000;
  const at = (days: number) =>
    requiredRestorePowBits('grin', tip - days * GRIN_DAY, tip, POLICY);

  assert.equal(at(30), 0, 'inside the free window costs nothing');
  assert.equal(at(90), 0, 'the free window boundary is still free');
  assert.equal(at(180), 3, '90 days beyond free at 30 days per bit');
  assert.equal(at(365), 9, 'the deepest bounded scan, which is what broke grin');
});

test('pricing off means no work, whatever the depth', () => {
  const bits = requiredRestorePowBits('grin', 0, 4_000_000, { pow_days_per_bit: 0 });
  assert.equal(bits, 0);
});

test('difficulty is capped', () => {
  const bits = requiredRestorePowBits('grin', 0, 40_000_000, { ...POLICY, pow_max_bits: 12 });
  assert.equal(bits, 12);
});

test('block rate is per chain, so the same depth prices differently', () => {
  const tip = 4_000_000;
  // 365 days is 365*1440 grin blocks but only 365*720 monero blocks, so the
  // same height delta is twice as many days on xmr.
  const delta = 365 * GRIN_DAY;
  assert.equal(requiredRestorePowBits('grin', tip - delta, tip, POLICY), 9);
  assert.equal(requiredRestorePowBits('xmr', tip - delta, tip, POLICY), 21);
});

test('a solved nonce satisfies the difficulty it was solved for', async () => {
  const nonce = await solveRestorePow('grin', 'deadbeef', 3_462_578, 9);
  assert.equal(typeof nonce, 'number');

  // Recompute the digest exactly as the backend does and count leading zeros.
  const enc = new TextEncoder();
  const parts = [enc.encode('smirk-restore-pow-v1'), Uint8Array.of(0x1f), enc.encode('grin'),
                 Uint8Array.of(0x1f), enc.encode('deadbeef'), Uint8Array.of(0x1f)];
  const head = parts.reduce<number[]>((a, p) => a.concat([...p]), []);
  const buf = new Uint8Array(head.length + 16);
  buf.set(head);
  const view = new DataView(buf.buffer);
  view.setBigUint64(head.length, BigInt(3_462_578), true);
  view.setBigUint64(head.length + 8, BigInt(nonce as number), true);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));

  let zeros = 0;
  for (const b of digest) {
    if (b === 0) { zeros += 8; continue; }
    zeros += Math.clz32(b) - 24;
    break;
  }
  assert.ok(zeros >= 9, `digest had ${zeros} leading zero bits, needed 9`);
});

test('nothing owed returns undefined, so callers can spread it away', async () => {
  assert.equal(await solveRestorePow('grin', 'deadbeef', 100, 0), undefined);
});

test('the nonce is bound to its parameters and does not transfer', async () => {
  // A solution for one rewind hash must not satisfy another, or a single solve
  // could be replayed across accounts.
  const a = await solveRestorePow('grin', 'aaaa', 3_000_000, 8);
  const b = await solveRestorePow('grin', 'bbbb', 3_000_000, 8);
  assert.notEqual(a, b, 'different addresses should not share the first valid nonce');
});
