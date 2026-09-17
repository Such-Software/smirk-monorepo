import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDecoyRings } from '../decoy-ring';

const out = (global_index: number) => ({ global_index, public_key: `k${global_index}` });

/** Every ring member's global index, for the invariant checks below. */
function indicesOf(rings: Array<Array<{ global_index: number }>>): number[][] {
  return rings.map((r) => r.map((m) => m.global_index));
}

test('a ring never repeats a global index', () => {
  // A repeated index is a zero delta, which CLSAG cannot encode: the signer
  // rejects the ring outright rather than producing a smaller anonymity set.
  const pool = [1, 2, 2, 3, 3, 3, 4, 5, 6, 7].map(out);
  const r = buildDecoyRings(pool, [99], 4);
  assert.ok(r.ok);
  for (const ring of indicesOf(r.rings)) {
    assert.equal(new Set(ring).size, ring.length, `ring repeats a member: ${ring}`);
  }
});

test('the output being spent is never also a decoy for itself', () => {
  // Its presence twice in the ring points straight at the real spend.
  const pool = [10, 11, 12, 13, 14].map(out);
  const r = buildDecoyRings(pool, [12], 3);
  assert.ok(r.ok);
  assert.ok(!indicesOf(r.rings)[0]?.includes(12));
});

test('two inputs of one transaction do not share a decoy', () => {
  const pool = Array.from({ length: 20 }, (_, i) => out(i));
  const r = buildDecoyRings(pool, [100, 101], 5);
  assert.ok(r.ok);
  const [a, b] = indicesOf(r.rings);
  assert.ok(a && b);
  for (const gi of a) {
    assert.ok(!b.includes(gi), `decoy ${gi} appears in both rings`);
  }
});

test('every ring comes out at full size', () => {
  const pool = Array.from({ length: 64 }, (_, i) => out(i));
  const realIndices = [1000, 1001, 1002];
  const r = buildDecoyRings(pool, realIndices, 15);
  assert.ok(r.ok);
  assert.equal(r.rings.length, realIndices.length);
  for (const ring of r.rings) assert.equal(ring.length, 15);
});

test('a pool too duplicate-heavy to fill a ring is an error, not a short ring', () => {
  // A ring below the protocol's size is worse than a failed send: the send can
  // be retried, but a thin ring is permanently visible on chain.
  const pool = [7, 7, 7, 7, 7, 7].map(out);
  const r = buildDecoyRings(pool, [1], 4);
  assert.ok(!r.ok);
  assert.match(r.error, /again/i);
});

test('the error names the situation rather than the failed call', () => {
  const r = buildDecoyRings([], [1], 4);
  assert.ok(!r.ok);
  assert.doesNotMatch(r.error, /Decoys::new|null|undefined/);
});
