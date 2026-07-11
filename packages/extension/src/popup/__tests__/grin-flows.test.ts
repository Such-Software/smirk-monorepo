/**
 * Regression tests for the scan-based Grin send orchestration in `grin-flows.ts`.
 *
 * v3 is non-custodial: startGrinSend no longer records/locks outputs on the
 * backend. Instead the client owns output state via a pending overlay. The
 * money-critical bookkeeping is RESERVED at build time (startGrinSend) so a
 * concurrent flow can't re-select an input or re-derive a child index, then
 * flipped to `broadcast` at finalize (processGrinS2). These tests lock in:
 *   - startGrinSend reserves the selected inputs + change AND advances the
 *     child-index counter AT BUILD TIME, with the entry NOT yet broadcast.
 *   - processGrinS2 marks that entry `broadcast` after a successful broadcast
 *     WITHOUT bumping the index again, and never touches the overlay on failure.
 *   - cancelGrinSend frees the reserved inputs while pre-broadcast, but must NOT
 *     free them once the tx has broadcast (double-spend guard).
 *
 * Style follows @smirk/core's tests: node:test, and stub the `wasm` singleton +
 * chain provider directly (no module-mock machinery).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chainProviders,
  GrinPendingOverlay,
  createMemoryGrinPendingStore,
  type SlatepackChannels,
} from '@smirk/core';
import { grin as wasmGrin } from '@smirk/wasm';
import {
  processGrinS2,
  processGrinI2,
  cancelGrinSend,
  startGrinSend,
  startGrinInvoice,
  resolveGrinSpendable,
} from '../grin-flows';

type AnyFn = (...args: unknown[]) => unknown;

const COMMIT_A = '09'.repeat(33);
const CHANGE_COMMIT = '08'.repeat(33);
const INPUT_COMMIT = '07'.repeat(33);
const SLATE_ID = 'test-slate-0001';

/** Stub the wasm finalize ceremony so we exercise the broadcast → overlay
 *  orchestration without a real wasm init. */
function stubWasm(): void {
  const w = wasmGrin as unknown as Record<string, AnyFn>;
  w.slatepackAddressSecret = () => '00'.repeat(32);
  w.finalizeSendSlate = () => ({
    slate_json: JSON.stringify({ id: SLATE_ID }),
    tx_json: { offset: '00', body: {} },
    kernel_excess_hex: 'ab'.repeat(33),
  });
}

/** Stub the wasm primitives startGrinSend calls (build S1 + armor). Returns a
 *  fixed change output so the reservation path (change + index bump) is covered. */
function stubWasmSend(): void {
  const w = wasmGrin as unknown as Record<string, AnyFn>;
  w.deriveExtendedKey = () => JSON.stringify({ extended_private_key_hex: '11'.repeat(32) });
  w.deriveExtendedKeyLegacyBip39 = () => '22'.repeat(32);
  w.randomSecretNonce = () => '33'.repeat(32);
  w.slateV4ToBinHex = () => 'aa';
  w.slatepackPackPlain = () => 'BEGINSLATEPACK. plain .ENDSLATEPACK.';
  w.slatepackPackEncrypted = () => 'BEGINSLATEPACK. enc .ENDSLATEPACK.';
  w.createSendTransaction = () => ({
    slate_id: SLATE_ID,
    slate_json: JSON.stringify({ id: SLATE_ID, sta: 'S1' }),
    slate_bin_hex: 'aa',
    sender_context_json: '{}',
    input_derivations: ['v3+Regular'],
    change_output: {
      path: [0, 0, 0, 0],
      amount: 3_976_000_000,
      commitment_hex: CHANGE_COMMIT,
      proof_hex: 'cc',
    },
  });
}

/** Stub the wasm primitives startGrinInvoice calls (create I1 + armor). */
function stubWasmInvoice(): void {
  const w = wasmGrin as unknown as Record<string, AnyFn>;
  w.deriveExtendedKey = () => JSON.stringify({ extended_private_key_hex: '11'.repeat(32) });
  w.randomSecretNonce = () => '33'.repeat(32);
  w.slateV4ToBinHex = () => 'aa';
  w.slatepackAddressToPubkeyHex = () => '44'.repeat(32);
  w.slatepackPackEncrypted = () => 'BEGINSLATEPACK. enc .ENDSLATEPACK.';
  w.createInvoice = () => ({
    slate_id: SLATE_ID,
    slate_json: JSON.stringify({ id: SLATE_ID, sta: 'I1' }),
    slate_bin_hex: 'aa',
    receiver_context_json: '{}',
    output: { path: [0, 0, 0, 0], amount: 2_000_000_000, commitment_hex: '05'.repeat(33), proof_hex: 'dd' },
  });
}

/** A resolver returning a single 5-GRIN spendable input at child index 0
 *  (bypasses the scan/identify path — those are covered by the overlay tests). */
function fakeResolver() {
  return {
    fetchSpendable: async () => ({
      outputs: [
        {
          path: [0, 0, 1, 0] as [number, number, number, number],
          amount: 5_000_000_000,
          commitment_hex: INPUT_COMMIT,
          is_coinbase: false,
        },
      ],
      nextChildIndex: 0,
    }),
  };
}

/** Swap in a fake grin provider whose broadcast returns `res`. */
function stubBroadcast(res: { data?: { success: boolean }; error?: string }): void {
  chainProviders.setGrin({
    asset: 'grin',
    capabilities: {} as never,
    scan: async () => ({ data: { outputs: [], total_balance: 0, last_pmmr_index: 0 }, status: 200 }),
    broadcast: async () => res,
    getHeight: async () => ({ data: { height: 100 }, status: 200 }),
    estimateFee: async () => ({ data: { model: 'formula' }, status: 200 }),
  } as never);
}

/** Channels whose settle/cancel just record that they were called. */
function fakeChannels(): { channels: SlatepackChannels; calls: string[] } {
  const calls: string[] = [];
  const mk = (kind: string) =>
    ({
      kind,
      deliver: async () => ({ id: SLATE_ID }),
      inbox: async () => [],
      respond: async () => undefined,
      cancel: async (id: string) => void calls.push(`${kind}.cancel:${id}`),
      settle: async (id: string) => void calls.push(`${kind}.settle:${id}`),
    }) as never;
  return { channels: { nostr: mk('nostr'), backend: mk('backend') }, calls };
}

const s2Args = (overlay: GrinPendingOverlay, channels: SlatepackChannels) => ({
  mnemonic:
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  s2: '{"id":"' + SLATE_ID + '"}', // raw JSON (not armored) → no dearmor
  sender_context_json: '{}',
  sender_inputs: [
    { path: [0, 0, 1, 0] as [number, number, number, number], amount: 5_000_000_000, commitment_hex: COMMIT_A, is_coinbase: false },
  ],
  change_output: {
    path: [0, 0, 2, 0] as [number, number, number, number],
    amount: 3_000_000_000,
    commitment_hex: CHANGE_COMMIT,
    proof_hex: 'cc',
  },
  channels,
  overlay,
});

test('startGrinSend reserves inputs + change + bumps index AT BUILD TIME (not yet broadcast)', async () => {
  stubWasmSend();
  stubBroadcast({ data: { success: true }, status: 200 } as never);
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  const { channels } = fakeChannels();

  const res = await startGrinSend({
    mnemonic: 'm',
    senderSlatepackAddress: 'grin1sender',
    // No recipient channel → manual/clipboard send, no delivery.
    channels,
    amount: 1_000_000_000,
    resolver: fakeResolver(),
    overlay,
  });
  assert.equal(res.slate_id, SLATE_ID);

  // The selected input is excluded from selection the moment S1 is built, so a
  // concurrent send can't re-pick it (double-spend) before broadcast.
  assert.ok(
    (await overlay.selectablePendingSpent()).has(INPUT_COMMIT),
    'input reserved at build time',
  );
  // The change shows as pending, and the change index is consumed at build time
  // so a concurrent flow can't re-derive the same commitment (fund loss).
  assert.equal(await overlay.pendingChangeValue([]), 3_976_000_000);
  assert.equal(await overlay.nextChildIndex(), 1);
  // But the entry is NOT yet broadcast — a cancel here would still free it.
  const p = await overlay.load();
  assert.equal(p.entries[SLATE_ID]?.broadcast, undefined, 'not broadcast until finalize');
});

test('processGrinS2 marks the reserved entry broadcast + settles, WITHOUT bumping the index again', async () => {
  stubWasm();
  stubBroadcast({ data: { success: true }, status: 200 } as never);
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  const { channels, calls } = fakeChannels();

  // Simulate the build-time reservation startGrinSend already performed (entry +
  // one consumed child index), then finalize.
  await overlay.addPending(SLATE_ID, {
    spentCommits: [COMMIT_A],
    change: { commit: CHANGE_COMMIT, value: 3_000_000_000 },
  });
  await overlay.bumpNextChildIndex();

  const res = await processGrinS2({
    ...s2Args(overlay, channels),
    relay_id: 'nostr:deadbeef',
  });
  assert.equal(res.slate_id, SLATE_ID);

  // The spent input stays excluded from selection.
  const spent = await overlay.selectablePendingSpent();
  assert.ok(spent.has(COMMIT_A), 'input commitment excluded from selection');
  // The change still shows as pending until scan confirms it.
  assert.equal(await overlay.pendingChangeValue([]), 3_000_000_000);
  // The entry is now flagged broadcast (so cancel can't free it).
  const p = await overlay.load();
  assert.equal(p.entries[SLATE_ID]?.broadcast, true, 'flagged broadcast');
  // processGrinS2 must NOT advance the counter again — it was bumped at build.
  assert.equal(await overlay.nextChildIndex(), 1);
  // The exchange was settled over the send's channel (nostr).
  assert.deepEqual(calls, [`nostr.settle:${SLATE_ID}`]);
});

test('processGrinS2 throws and records NOTHING when the broadcast fails', async () => {
  stubWasm();
  stubBroadcast({ error: 'node rejected: low fee' });
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  const { channels } = fakeChannels();

  await assert.rejects(processGrinS2(s2Args(overlay, channels)), /Broadcast failed/);
  // No overlay mutation on a failed broadcast (inputs stay selectable).
  assert.equal((await overlay.selectablePendingSpent()).size, 0);
  assert.equal(await overlay.nextChildIndex(), 0);
});

test('cancelGrinSend frees the reserved inputs and cancels on the channel', async () => {
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  await overlay.addPending(SLATE_ID, { spentCommits: [COMMIT_A] });
  const { channels, calls } = fakeChannels();

  await cancelGrinSend({ slate_id: SLATE_ID, relay_id: `backend:u-alice`, channels, overlay });

  assert.equal((await overlay.selectablePendingSpent()).size, 0, 'inputs selectable again');
  assert.deepEqual(calls, [`backend.cancel:${SLATE_ID}`]);
});

test('startGrinInvoice reserves the child index but does NOT inflate the pending balance', async () => {
  stubWasmInvoice();
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());

  const res = await startGrinInvoice({
    mnemonic: 'm',
    receiverSlatepackAddress: 'grin1recv',
    amount: 2_000_000_000,
    fee: 23_000_000,
    resolver: fakeResolver(),
    overlay,
  });
  assert.equal(res.slate_id, SLATE_ID);

  // The receive-output index IS reserved (never reuse a child index → fund loss),
  // even though nobody has paid the invoice yet.
  assert.equal(await overlay.nextChildIndex(), 1);
  // But the speculative incoming value must NOT count toward pending balance —
  // creating an invoice can't inflate headline wealth before the payer commits.
  assert.equal(await overlay.pendingChangeValue([]), 0, 'no speculative pending inflation');
  // No pending entry recorded for a freshly-created invoice.
  const p = await overlay.load();
  assert.equal(p.entries[SLATE_ID], undefined, 'no incoming entry until the payer commits');
});

test('processGrinI2 records the incoming as pending after a successful broadcast', async () => {
  // Finding 4: the invoice receiver's finalize+broadcast must surface the received
  // value in the pending balance until the next scan confirms it (symmetric with
  // signIncomingGrinSlate) — the commitment + amount come from the receiver
  // context we created at invoice time.
  const RECEIVER_COMMIT = '06'.repeat(33);
  const w = wasmGrin as unknown as Record<string, AnyFn>;
  w.slatepackAddressSecret = () => '00'.repeat(32);
  w.finalizeInvoice = () => ({
    slate_json: JSON.stringify({ id: SLATE_ID }),
    final_signature_hex: 'ff'.repeat(32),
    kernel_excess_hex: 'ab'.repeat(33),
    tx_bytes_hex: 'aa',
    tx_json: { offset: '00', body: {} },
  });
  stubBroadcast({ data: { success: true }, status: 200 } as never);
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());

  const res = await processGrinI2({
    mnemonic: 'm',
    // Raw JSON (not armored) with no coms → no sender inputs to extract.
    i2: JSON.stringify({ id: SLATE_ID, coms: [] }),
    // ReceiverContext serde shape: `commitment` hex + `amount`.
    receiver_context_json: JSON.stringify({
      slate_id: SLATE_ID,
      amount: 2_000_000_000,
      commitment: RECEIVER_COMMIT,
    }),
    overlay,
  });
  assert.equal(res.slate_id, SLATE_ID);

  // The received value shows as pending until scan confirms the output.
  assert.equal(await overlay.pendingChangeValue([]), 2_000_000_000);
  // Once scanned it drops out (counted by the confirmed balance instead).
  assert.equal(await overlay.pendingChangeValue([{ commit: RECEIVER_COMMIT }]), 0);
  // It's flagged broadcast (WE put it on-chain) so a stray cancel can't wipe it.
  const p = await overlay.load();
  assert.equal(p.entries[SLATE_ID]?.broadcast, true);
});

test('processGrinI2 records NOTHING when the broadcast fails', async () => {
  const w = wasmGrin as unknown as Record<string, AnyFn>;
  w.slatepackAddressSecret = () => '00'.repeat(32);
  w.finalizeInvoice = () => ({
    slate_json: JSON.stringify({ id: SLATE_ID }),
    final_signature_hex: 'ff'.repeat(32),
    kernel_excess_hex: 'ab'.repeat(33),
    tx_bytes_hex: 'aa',
    tx_json: { offset: '00', body: {} },
  });
  stubBroadcast({ error: 'node rejected: low fee' });
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());

  await assert.rejects(
    processGrinI2({
      mnemonic: 'm',
      i2: JSON.stringify({ id: SLATE_ID, coms: [] }),
      receiver_context_json: JSON.stringify({ amount: 2_000_000_000, commitment: '06'.repeat(33) }),
      overlay,
    }),
    /Broadcast failed/,
  );
  assert.equal(await overlay.pendingChangeValue([]), 0, 'no pending recorded on failed broadcast');
});

// A canonical Smirk identifier for child index 42: depth 4, path [0, 0, 42, 0]
// (0x2a = 42), each element a big-endian u32. This is what grin-lws returns as
// `key_id`; the spendable index is path[2], NOT the trailing n_child.
const KEY_ID_IDX_42 = '04' + '00000000' + '00000000' + '0000002a' + '00000000';

/** Swap in a grin provider whose scan returns `outputs` and tip `height`.
 *  Also stubs the wasm key-derivation + identify so we can assert whether the
 *  client-side identify search runs. Returns a probe of identify calls. */
function stubScanProvider(
  outputs: unknown[],
  height: number,
): { identifyCalls: string[] } {
  chainProviders.setGrin({
    asset: 'grin',
    capabilities: {} as never,
    scan: async () => ({ data: { outputs, total_balance: 0, last_pmmr_index: 0 }, status: 200 }),
    broadcast: async () => ({ data: { success: true }, status: 200 }),
    getHeight: async () => ({ data: { height }, status: 200 }),
    estimateFee: async () => ({ data: { model: 'formula' }, status: 200 }),
  } as never);
  const identifyCalls: string[] = [];
  const w = wasmGrin as unknown as Record<string, AnyFn>;
  w.deriveExtendedKey = () => JSON.stringify({ extended_private_key_hex: '11'.repeat(32) });
  w.deriveExtendedKeyLegacyBip39 = () => '22'.repeat(32);
  // Default identify: record the commit and "find" it at index 7.
  w.identifyOutput = (..._a: unknown[]) => {
    identifyCalls.push(String(_a[2]));
    return [0, 0, 7, 0];
  };
  return { identifyCalls };
}

const scanDeps = (overlay: GrinPendingOverlay) => ({
  mnemonic:
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  rewindHash: 'ab'.repeat(32),
  overlay,
});

test('resolveGrinSpendable spends via grin-lws key_id and SKIPS the identify search', async () => {
  const { identifyCalls } = stubScanProvider(
    [
      {
        commit: COMMIT_A,
        value: 5_000_000_000,
        height: 100,
        mmr_index: 1,
        is_coinbase: false,
        lock_height: 0,
        key_id: KEY_ID_IDX_42,
        n_child: 0,
        spendable: true,
      },
    ],
    200, // tip well past the output → mature
  );
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());

  const res = await resolveGrinSpendable(scanDeps(overlay));

  // The path came straight from key_id (index 42 = path[2]), no search ran.
  assert.deepEqual(res.outputs, [
    { path: [0, 0, 42, 0], amount: 5_000_000_000, commitment_hex: COMMIT_A, is_coinbase: false },
  ]);
  assert.deepEqual(identifyCalls, [], 'identifyOutput must not run when key_id is present');
  // The counter is NOT seeded from an UNVERIFIED key_id index: the client never
  // re-derived the commitment for [0,0,42,0], so a hostile/buggy LWS can't move
  // nextChildIndex. Only identifyOutput-verified indices seed it (see the tests
  // below); here nothing was verified, so the counter stays put.
  assert.equal(await overlay.nextChildIndex(), 0);
});

test('resolveGrinSpendable does NOT seed the counter from an unverified (even absurd) key_id', async () => {
  // A hostile/buggy LWS reports a key_id claiming a wild child index. We still
  // spend via that path (a wrong path only yields a node-rejected tx, never a
  // loss), but it must NOT poison the money-critical child-index counter.
  const KEY_ID_HUGE = '04' + '00000000' + '00000000' + '7fffffff' + '00000000'; // idx 0x7fffffff
  const { identifyCalls } = stubScanProvider(
    [
      {
        commit: COMMIT_A,
        value: 5_000_000_000,
        height: 100,
        mmr_index: 1,
        is_coinbase: false,
        lock_height: 0,
        key_id: KEY_ID_HUGE,
      },
    ],
    200,
  );
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());

  const res = await resolveGrinSpendable(scanDeps(overlay));

  // Spendable via the key_id path (index 0x7fffffff = 2147483647).
  assert.equal(res.outputs[0]?.path[2], 0x7fffffff);
  assert.deepEqual(identifyCalls, [], 'identifyOutput must not run when key_id is present');
  // Counter untouched — the absurd index never reached it.
  assert.equal(await overlay.nextChildIndex(), 0);
});

test('resolveGrinSpendable seeds the counter ONLY from the identify-verified index, not the key_id', async () => {
  // Two selectable outputs: one recovered via key_id (index 42, unverified), one
  // with no key_id that goes through the verified identify search (stubbed to
  // index 7). The counter must seed from the VERIFIED 7 (→ 8), never the 42.
  const COMMIT_B = '0a'.repeat(33);
  const { identifyCalls } = stubScanProvider(
    [
      {
        commit: COMMIT_A,
        value: 5_000_000_000,
        height: 100,
        mmr_index: 1,
        is_coinbase: false,
        lock_height: 0,
        key_id: KEY_ID_IDX_42, // unverified → spend-only, never seeds
      },
      {
        commit: COMMIT_B,
        value: 2_000_000_000,
        height: 100,
        mmr_index: 2,
        is_coinbase: false,
        lock_height: 0,
        key_id: null, // → verified identify search → index 7
      },
    ],
    200,
  );
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());

  const res = await resolveGrinSpendable(scanDeps(overlay));

  // Both are spendable (key_id path for A, verified search path for B).
  assert.deepEqual(res.outputs.map((o) => o.path[2]).sort((a, b) => a - b), [7, 42]);
  // identify ran only for the key_id-less output.
  assert.deepEqual(identifyCalls, [COMMIT_B], 'identify runs only when key_id is absent');
  // Seeded from the VERIFIED index 7 (+1), NOT the higher unverified key_id 42.
  assert.equal(await overlay.nextChildIndex(), 8);
});

test('resolveGrinSpendable falls back to the identify search when key_id is absent', async () => {
  const { identifyCalls } = stubScanProvider(
    [
      {
        commit: COMMIT_A,
        value: 5_000_000_000,
        height: 100,
        mmr_index: 1,
        is_coinbase: false,
        lock_height: 0,
        key_id: null, // grin-wallet fallback path: no recovered key_id
      },
    ],
    200,
  );
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());

  const res = await resolveGrinSpendable(scanDeps(overlay));

  // No key_id → the verified client-side search runs and supplies the path.
  assert.deepEqual(identifyCalls, [COMMIT_A], 'identifyOutput runs on the fallback path');
  assert.deepEqual(res.outputs, [
    { path: [0, 0, 7, 0], amount: 5_000_000_000, commitment_hex: COMMIT_A, is_coinbase: false },
  ]);
});

test('resolveGrinSpendable ignores a NON-canonical key_id and falls back to identify', async () => {
  // A malformed / non-Smirk-shaped identifier (depth 3) must never be trusted as
  // a spend path; the verified search takes over.
  const NON_CANONICAL = '03' + '00000000' + '00000000' + '0000002a' + '00000000';
  const { identifyCalls } = stubScanProvider(
    [
      {
        commit: COMMIT_A,
        value: 5_000_000_000,
        height: 100,
        mmr_index: 1,
        is_coinbase: false,
        lock_height: 0,
        key_id: NON_CANONICAL,
      },
    ],
    200,
  );
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());

  const res = await resolveGrinSpendable(scanDeps(overlay));

  assert.deepEqual(identifyCalls, [COMMIT_A], 'non-canonical key_id defers to the search');
  assert.equal(res.outputs[0]?.path[2], 7);
});

test('cancelGrinSend does NOT free inputs (or notify) once the tx has broadcast', async () => {
  const overlay = new GrinPendingOverlay(createMemoryGrinPendingStore());
  // A broadcast entry: its inputs are genuinely spent in-flight.
  await overlay.addPending(SLATE_ID, { broadcast: true, spentCommits: [COMMIT_A] });
  const { channels, calls } = fakeChannels();

  await cancelGrinSend({ slate_id: SLATE_ID, relay_id: `backend:u-alice`, channels, overlay });

  // Inputs stay excluded (freeing them would allow a double-spend), and no cancel
  // notice goes out for an already-settled exchange.
  assert.ok(
    (await overlay.selectablePendingSpent()).has(COMMIT_A),
    'broadcast inputs stay reserved',
  );
  assert.deepEqual(calls, []);
});
