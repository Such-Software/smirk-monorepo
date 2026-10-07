/**
 * The send journal holds who a wallet paid and the transaction keys that prove
 * it. These tests pin the at-rest properties: nothing readable in storage, a
 * round trip under the right key, nothing under the wrong key or the wrong
 * wallet's slot, and pre-encryption journals sealed on first keyed read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

let store: Record<string, unknown> = {};
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        Object.assign(store, obj);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      },
    },
  },
};

const {
  recordSend,
  readSendJournal,
  getSendRecord,
  setSendJournalScope,
  sendJournalKey,
  SEND_JOURNAL_KEY,
} = await import('../send-journal');

const KEY_A = sendJournalKey(new Uint8Array(32).fill(1));
const KEY_B = sendJournalKey(new Uint8Array(32).fill(2));

const entry = {
  txid: 'aa'.repeat(32),
  asset: 'xmr',
  destination: '4RecipientAddressExample',
  amountAtomic: '1500000000000',
  feeAtomic: '30000000',
  txKeyHex: 'cd'.repeat(32),
  outgoingViewKeyHex: 'ef'.repeat(32),
  createdAt: 1_790_000_000_000,
};

function reset(fp: string | null): void {
  store = {};
  setSendJournalScope(fp);
}

test('nothing secret is readable in storage', async () => {
  reset('fp-a');
  await recordSend(entry, KEY_A);
  const raw = JSON.stringify(store);
  assert.ok(raw.length > 0);
  for (const secret of [entry.destination, entry.txKeyHex, entry.outgoingViewKeyHex, entry.amountAtomic]) {
    assert.ok(!raw.includes(secret), `storage must not contain ${secret.slice(0, 8)}...`);
  }
  const slot = store[`${SEND_JOURNAL_KEY}:fp-a`] as { v: number; ct: string };
  assert.equal(slot.v, 2);
});

test('round trip under the wallet key, merging later writes by txid', async () => {
  reset('fp-a');
  await recordSend({ ...entry, txKeyHex: undefined }, KEY_A);
  await recordSend({ ...entry }, KEY_A);
  const all = await readSendJournal(KEY_A);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.txKeyHex, entry.txKeyHex);
  assert.equal(all[0]!.destination, entry.destination);
  assert.deepEqual(await getSendRecord(entry.txid, KEY_A), all[0]);
});

test('the wrong key reads nothing and cannot overwrite the journal', async () => {
  reset('fp-a');
  await recordSend(entry, KEY_A);
  const before = JSON.stringify(store);
  assert.deepEqual(await readSendJournal(KEY_B), []);
  await recordSend({ ...entry, txid: 'bb'.repeat(32) }, KEY_B);
  assert.equal(JSON.stringify(store), before, 'a write under the wrong key must not replace the sealed journal');
  assert.equal((await readSendJournal(KEY_A)).length, 1);
});

test('a sealed journal copied into another wallet slot does not decrypt there', async () => {
  reset('fp-a');
  await recordSend(entry, KEY_A);
  store[`${SEND_JOURNAL_KEY}:fp-b`] = store[`${SEND_JOURNAL_KEY}:fp-a`];
  setSendJournalScope('fp-b');
  assert.deepEqual(await readSendJournal(KEY_A), []);
});

test('a pre-encryption plaintext journal is read, then sealed', async () => {
  reset('fp-a');
  store[`${SEND_JOURNAL_KEY}:fp-a`] = { entries: { [entry.txid]: entry } };
  const all = await readSendJournal(KEY_A);
  assert.equal(all.length, 1);
  const raw = JSON.stringify(store);
  assert.ok(!raw.includes(entry.destination), 'the legacy plaintext must be replaced by ciphertext');
  assert.equal((store[`${SEND_JOURNAL_KEY}:fp-a`] as { v: number }).v, 2);
});

test('no wallet scope: nothing is written or read', async () => {
  reset(null);
  await recordSend(entry, KEY_A);
  assert.deepEqual(store, {});
  assert.deepEqual(await readSendJournal(KEY_A), []);
});
