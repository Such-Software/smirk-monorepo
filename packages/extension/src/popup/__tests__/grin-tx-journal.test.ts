/**
 * Unit tests for the client-side Grin tx-history journal (grin-tx-journal.ts).
 *
 * The journal is DISPLAY-ONLY (never gates money), so the invariants under test
 * are about faithful append + merge behaviour and unconditional best-effort
 * resilience:
 *   - a first record inserts; a second record for the same slateId MERGES
 *     (preserves createdAt + direction, upgrades status, fills kernelExcess),
 *   - a 0-amount finalize can't clobber the real build-time amount,
 *   - status updates are no-ops for unknown slateIds,
 *   - every function swallows storage failures and never rejects.
 *
 * Style follows the other extension tests: node:test + a hand-rolled
 * chrome.storage.local memory mock (no module-mock machinery).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal in-memory chrome.storage.local mock, installed before import use ──
let store: Record<string, unknown> = {};
function installChromeMock(): void {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) =>
          key in store ? { [key]: store[key] } : {},
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
      },
    },
  };
}
installChromeMock();

const {
  recordGrinTx,
  updateGrinTxStatus,
  readGrinJournal,
  GRIN_TX_JOURNAL_KEY,
} = await import('../grin-tx-journal');

test('records a send then reads it back as a journal row', async () => {
  installChromeMock();
  await recordGrinTx({
    slateId: 's-send-1',
    direction: 'send',
    amountNanogrin: 5_000_000_000,
    fee: 23_000_000,
    counterparty: 'u-bob',
    status: 'pending',
    createdAt: 1_000,
  });
  const rows = await readGrinJournal();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    slateId: 's-send-1',
    direction: 'send',
    amountNanogrin: 5_000_000_000,
    fee: 23_000_000,
    counterparty: 'u-bob',
    status: 'pending',
    createdAt: 1_000,
  });
});

test('a finalize record MERGES onto the pending row: keeps createdAt/direction/amount, upgrades status + kernelExcess', async () => {
  installChromeMock();
  await recordGrinTx({
    slateId: 's-send-2',
    direction: 'send',
    amountNanogrin: 5_000_000_000,
    fee: 23_000_000,
    counterparty: 'u-bob',
    status: 'pending',
    createdAt: 1_000,
  });
  // processGrinS2-shaped follow-up: amount 0 (unknown at finalize), new status +
  // kernel excess. Must not clobber the real amount or the original createdAt.
  await recordGrinTx({
    slateId: 's-send-2',
    direction: 'send',
    amountNanogrin: 0,
    status: 'finalized',
    kernelExcess: 'ab'.repeat(33),
    createdAt: 9_999,
  });
  const rows = await readGrinJournal();
  assert.equal(rows.length, 1, 'merge, not append');
  assert.deepEqual(rows[0], {
    slateId: 's-send-2',
    direction: 'send',
    amountNanogrin: 5_000_000_000, // preserved (0 did not clobber)
    fee: 23_000_000,
    counterparty: 'u-bob',
    status: 'finalized', // upgraded
    kernelExcess: 'ab'.repeat(33), // filled
    createdAt: 1_000, // anchored to first write
  });
});

test('updateGrinTxStatus flips an existing entry to cancelled', async () => {
  installChromeMock();
  await recordGrinTx({
    slateId: 's-send-3',
    direction: 'send',
    amountNanogrin: 1_000_000_000,
    status: 'pending',
    createdAt: 2_000,
  });
  await updateGrinTxStatus('s-send-3', 'cancelled');
  const rows = await readGrinJournal();
  assert.equal(rows[0]?.status, 'cancelled');
  assert.equal(rows[0]?.createdAt, 2_000);
});

test('updateGrinTxStatus is a no-op for an unknown slateId (no phantom row)', async () => {
  installChromeMock();
  await updateGrinTxStatus('nope', 'cancelled');
  assert.deepEqual(await readGrinJournal(), []);
});

test('distinct slateIds append as separate rows', async () => {
  installChromeMock();
  await recordGrinTx({ slateId: 'a', direction: 'send', amountNanogrin: 1, status: 'pending', createdAt: 1 });
  await recordGrinTx({ slateId: 'b', direction: 'receive', amountNanogrin: 2, status: 'pending', createdAt: 2 });
  const rows = await readGrinJournal();
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.slateId)), new Set(['a', 'b']));
});

test('best-effort: writes never reject and reads return [] when chrome is unavailable', async () => {
  // Simulate a hostile environment: chrome throws on every access.
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async () => {
          throw new Error('storage exploded');
        },
        set: async () => {
          throw new Error('storage exploded');
        },
      },
    },
  };
  // Must resolve (not reject) despite the storage layer throwing.
  await recordGrinTx({ slateId: 'x', direction: 'send', amountNanogrin: 1, status: 'pending', createdAt: 1 });
  await updateGrinTxStatus('x', 'cancelled');
  assert.deepEqual(await readGrinJournal(), []);
  installChromeMock();
});

test('load tolerates a garbage / legacy value in the slot', async () => {
  installChromeMock();
  store[GRIN_TX_JOURNAL_KEY] = 'not-an-object';
  assert.deepEqual(await readGrinJournal(), []);
  // A subsequent record still works (overwrites the garbage with a valid shape).
  await recordGrinTx({ slateId: 'y', direction: 'receive', amountNanogrin: 7, status: 'finalized', createdAt: 3 });
  const rows = await readGrinJournal();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.slateId, 'y');
});
