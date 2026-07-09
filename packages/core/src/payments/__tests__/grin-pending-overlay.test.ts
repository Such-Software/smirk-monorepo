/**
 * Money-critical overlay behaviour: exclude just-spent inputs from selection,
 * surface unconfirmed change/incoming as pending, clear entries only when scan
 * proves settlement (or the 7-day backstop), and NEVER reuse a child index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GrinPendingOverlay,
  addPendingEntry,
  selectablePendingSpentSet,
  pendingChangeValue,
  reconcilePending,
  seedNextChildIndexPure,
  bumpNextChildIndexPure,
  createMemoryGrinPendingStore,
  EMPTY_GRIN_PENDING,
  GRIN_PENDING_TTL_SECS,
} from '../grin-pending-overlay';

const NOW = 1_800_000_000;

test('selectablePendingSpent unions every entry input commitment', () => {
  let p = EMPTY_GRIN_PENDING;
  p = addPendingEntry(p, 's1', { spentCommits: ['a', 'b'] }, NOW);
  p = addPendingEntry(p, 's2', { spentCommits: ['b', 'c'] }, NOW);
  assert.deepEqual([...selectablePendingSpentSet(p)].sort(), ['a', 'b', 'c']);
});

test('pendingChangeValue counts change+incoming only while unscanned', () => {
  let p = EMPTY_GRIN_PENDING;
  p = addPendingEntry(p, 's1', { spentCommits: ['a'], change: { commit: 'chg', value: 100 } }, NOW);
  p = addPendingEntry(p, 's2', { incoming: { commit: 'inc', value: 50 } }, NOW);
  // Nothing scanned yet → both count.
  assert.equal(pendingChangeValue(p, []), 150);
  // Change now confirmed → drops out (avoids double-count vs confirmed balance).
  assert.equal(pendingChangeValue(p, [{ commit: 'chg' }]), 50);
  assert.equal(pendingChangeValue(p, [{ commit: 'chg' }, { commit: 'inc' }]), 0);
});

test('reconcile clears a send entry only once inputs are gone AND change confirmed', () => {
  let p = EMPTY_GRIN_PENDING;
  p = addPendingEntry(p, 's1', { spentCommits: ['in1'], change: { commit: 'chg', value: 7 } }, NOW);

  // Inputs still in the UTXO set (not yet mined) → keep.
  p = reconcilePending(p, [{ commit: 'in1' }], NOW);
  assert.ok(p.entries['s1'], 'kept while inputs unspent');

  // Inputs gone but change not yet visible → still keep (mid-confirmation).
  p = reconcilePending(p, [], NOW);
  assert.ok(p.entries['s1'], 'kept until change confirms');

  // Inputs gone AND change confirmed → settled, delete.
  p = reconcilePending(p, [{ commit: 'chg' }], NOW);
  assert.equal(p.entries['s1'], undefined, 'cleared when fully settled');
});

test('reconcile clears a receive entry when its incoming output is scanned', () => {
  let p = EMPTY_GRIN_PENDING;
  p = addPendingEntry(p, 'r1', { incoming: { commit: 'inc', value: 9 } }, NOW);
  p = reconcilePending(p, [], NOW);
  assert.ok(p.entries['r1'], 'kept until incoming confirms');
  p = reconcilePending(p, [{ commit: 'inc' }], NOW);
  assert.equal(p.entries['r1'], undefined, 'cleared when incoming scanned');
});

test('reconcile clears a no-change sweep once inputs are gone', () => {
  let p = EMPTY_GRIN_PENDING;
  p = addPendingEntry(p, 'sweep', { spentCommits: ['in1', 'in2'] }, NOW);
  p = reconcilePending(p, [{ commit: 'in2' }], NOW);
  assert.ok(p.entries['sweep'], 'kept while any input remains');
  p = reconcilePending(p, [], NOW);
  assert.equal(p.entries['sweep'], undefined, 'cleared once all inputs mined');
});

test('reconcile 7-day backstop drops a wedged entry even if unsettled', () => {
  let p = EMPTY_GRIN_PENDING;
  p = addPendingEntry(p, 'stuck', { spentCommits: ['in1'] }, NOW);
  // Inputs still present (never mined) but past TTL.
  const later = NOW + GRIN_PENDING_TTL_SECS + 1;
  p = reconcilePending(p, [{ commit: 'in1' }], later);
  assert.equal(p.entries['stuck'], undefined, 'aged-out entry removed');
});

test('broadcast flag round-trips through clone/persist (build-reservation vs broadcast)', async () => {
  // A pure build-time reservation has no broadcast flag.
  let p = EMPTY_GRIN_PENDING;
  p = addPendingEntry(p, 'reserved', { spentCommits: ['in1'] }, NOW);
  assert.equal(p.entries['reserved']!.broadcast, undefined);
  // A broadcast entry carries broadcast=true and survives a clone (reconcile
  // clones internally).
  p = addPendingEntry(p, 'sent', { spentCommits: ['in2'], broadcast: true }, NOW);
  p = reconcilePending(p, [{ commit: 'in1' }, { commit: 'in2' }], NOW);
  assert.equal(p.entries['sent']!.broadcast, true, 'flag preserved through clone');

  // And through the store adapter.
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  await overlay.addPending('s', { spentCommits: ['a'], broadcast: true });
  assert.equal((await overlay.load()).entries['s']!.broadcast, true);
});

test('nextChildIndex seeds up only, never rewinds, and bumps monotonically', () => {
  let p = EMPTY_GRIN_PENDING;
  p = seedNextChildIndexPure(p, 5);
  assert.equal(p.nextChildIndex, 5);
  // A lower/stale candidate must not rewind the counter (reuse = fund loss).
  const same = seedNextChildIndexPure(p, 3);
  assert.equal(same, p, 'no-op when candidate <= current');
  assert.equal(same.nextChildIndex, 5);
  p = bumpNextChildIndexPure(p);
  assert.equal(p.nextChildIndex, 6);
});

test('reserveNextChildIndex hands each caller a UNIQUE index under concurrency', async () => {
  // The money-critical race: two mint flows that both read-then-bump could be
  // handed the SAME index (duplicate Pedersen commitment → fund loss). An atomic
  // reserve must serialize so every concurrent caller gets a distinct value.
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  await overlay.seedNextChildIndex(10);

  // Fire 50 reservations concurrently (all started before any awaits resolve).
  const reserved = await Promise.all(
    Array.from({ length: 50 }, () => overlay.reserveNextChildIndex()),
  );

  // Every index is unique...
  assert.equal(new Set(reserved).size, 50, 'no index handed out twice');
  // ...they cover exactly 10..59 (contiguous, no gaps, no reuse)...
  assert.deepEqual([...reserved].sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => 10 + i));
  // ...and the persisted counter advanced past all of them.
  assert.equal(await overlay.nextChildIndex(), 60);
});

test('reserveNextChildIndex interleaved with addPending never loses the bump', async () => {
  // A concurrent index reservation and an entry write must not clobber each other
  // (both are load-modify-save on the same blob).
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  await Promise.all([
    overlay.reserveNextChildIndex(),
    overlay.addPending('s1', { spentCommits: ['in1'] }),
    overlay.reserveNextChildIndex(),
    overlay.addPending('s2', { spentCommits: ['in2'] }),
  ]);
  // Both entries survived AND both reservations advanced the counter.
  assert.equal(await overlay.nextChildIndex(), 2, 'both bumps persisted');
  assert.deepEqual([...(await overlay.selectablePendingSpent())].sort(), ['in1', 'in2']);
});

test('TWO overlay instances over the same store-key serialize (no lost update / counter rewind)', async () => {
  // The money-critical cross-instance race: production has an always-on ~30s
  // reconcile on one overlay while a send/claim/inbox path may hold ANOTHER
  // overlay over the SAME chrome.storage slot. Each overlay's mutex is
  // per-instance, so without a process-global per-key lock their load-modify-save
  // ops interleave → a reserve read behind a stale counter rewinds it (duplicate
  // commitment = fund loss) or a bump clobbers a concurrent entry write.
  //
  // Sharing ONE backing store + the SAME key opts both overlays into the global
  // per-key lock, so this must behave EXACTLY like a single overlay would.
  const KEY = 'grin_pending_v1';
  const store = createMemoryGrinPendingStore(EMPTY_GRIN_PENDING, KEY);
  const a = new GrinPendingOverlay(store); // e.g. the balance-reconcile owner
  const b = new GrinPendingOverlay(store); // e.g. a claim/send/inbox path

  await a.seedNextChildIndex(100);

  // Interleave reservations AND an entry write across BOTH instances, all fired
  // before any await resolves. If the two instances didn't share a lock, two of
  // these reserves would read the same counter value.
  const ops = await Promise.all([
    a.reserveNextChildIndex(),
    b.reserveNextChildIndex(),
    a.reserveNextChildIndex(),
    b.reserveNextChildIndex(),
    a.reserveNextChildIndex(),
    b.reserveNextChildIndex(),
  ]);
  // Also interleave entry writes from both instances against the reservations.
  await Promise.all([
    a.addPending('sa', { spentCommits: ['inA'] }),
    b.addPending('sb', { spentCommits: ['inB'] }),
    a.reserveNextChildIndex(),
    b.reserveNextChildIndex(),
  ]);

  // Every reserved index is UNIQUE — no cross-instance rewind handed a dup.
  assert.equal(new Set(ops).size, ops.length, 'no index handed out twice across instances');
  // Contiguous 100..105 for the first batch (proves no rewind, no gap).
  assert.deepEqual(
    [...ops].sort((x, y) => x - y),
    [100, 101, 102, 103, 104, 105],
  );
  // 6 + 2 = 8 total reservations from index 100 → counter now 108, and NEITHER
  // entry write was lost to a clobbering counter save.
  assert.equal(await a.nextChildIndex(), 108, 'all 8 bumps persisted, none clobbered');
  assert.deepEqual(
    [...(await b.selectablePendingSpent())].sort(),
    ['inA', 'inB'],
    'both instances’ entry writes survived the interleaving',
  );
});

test('remove() frees a pre-broadcast reservation but REFUSES a broadcast entry', async () => {
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  // A pre-broadcast build reservation (falsy broadcast) — freeable.
  await overlay.addPending('reserved', { spentCommits: ['inA'] });
  // A broadcast tx — its inputs are spent in-flight; must NOT be freed.
  await overlay.addPending('sent', { spentCommits: ['inB'], broadcast: true });

  await overlay.remove('reserved');
  await overlay.remove('sent');

  const spent = await overlay.selectablePendingSpent();
  assert.ok(!spent.has('inA'), 'pre-broadcast reservation freed');
  assert.ok(spent.has('inB'), 'broadcast entry NOT freed (double-spend guard)');
});

test('overlay adapter persists across load/save through the store', async () => {
  const store = createMemoryGrinPendingStore();
  const overlay = new GrinPendingOverlay(store);

  await overlay.seedNextChildIndex(3);
  await overlay.addPending('s1', { spentCommits: ['in1'], change: { commit: 'chg', value: 10 } });
  await overlay.bumpNextChildIndex();

  assert.deepEqual([...(await overlay.selectablePendingSpent())], ['in1']);
  assert.equal(await overlay.pendingChangeValue([]), 10);
  assert.equal(await overlay.nextChildIndex(), 4);

  // Explicit cancel frees the input immediately.
  await overlay.remove('s1');
  assert.equal((await overlay.selectablePendingSpent()).size, 0);

  // A fresh overlay over the same store sees the persisted counter.
  const reopened = new GrinPendingOverlay(store);
  assert.equal(await reopened.nextChildIndex(), 4);
});
