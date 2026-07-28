/**
 * XMR/WOW spend path: `subaddr_index` threading (Lane 4).
 *
 * MONEY-CRITICAL. A subaddress output's key image folds the subaddress spend
 * secret into the key offset. Spend one under the primary index and the key
 * image does not match the output: the daemon rejects the tx, and because the
 * wallet also computes that wrong key image when reconciling against the LWS's
 * `spend_key_images` list, the output is effectively stranded. So the index the
 * LWS attributed to each output has to reach BOTH the key-image computation and
 * the wasm signing params, verbatim.
 *
 * These tests drive the real `send()` with the wasm namespace and the LWS chain
 * provider stubbed (the @smirk/core + grin-flows test style: patch the exported
 * singletons, no module-mock machinery), then inspect exactly what the spend
 * path handed to wasm.
 */

import './_chrome-stub';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { chainProviders, type UnlockedWallet } from '@smirk/core';
import { monero as wasmMonero } from '@smirk/wasm';

import { send } from '../send-handler';

type AnyFn = (...args: unknown[]) => unknown;

const PRIMARY_WOW = 'Wo-primary-wow-address';
const TO_ADDRESS = 'Wo-recipient-address';

function makeWallet(): UnlockedWallet {
  const cn = {
    privateSpendKey: new Uint8Array(32).fill(3),
    privateViewKey: new Uint8Array(32).fill(7),
    publicSpendKey: new Uint8Array(32).fill(5),
    publicViewKey: new Uint8Array(32).fill(9),
  };
  return {
    fingerprint: 'fp-send',
    keys: { xmr: cn, wow: cn },
    addresses: { wow: PRIMARY_WOW, xmr: '4primary-xmr' },
  } as unknown as UnlockedWallet;
}

interface StubOutput {
  amount: string;
  public_key: string;
  tx_pub_key: string;
  index: number;
  global_index: number;
  height: number;
  rct: string;
  spend_key_images: string[];
  subaddr_index?: { major: number; minor: number };
}

function out(overrides: Partial<StubOutput> & { index: number }): StubOutput {
  return {
    amount: '5000000000000',
    public_key: `pk${overrides.index}`,
    tx_pub_key: `txpub${overrides.index}`,
    global_index: 1000 + overrides.index,
    height: 100,
    rct: 'rct',
    spend_key_images: [],
    ...overrides,
  };
}

/** Records of what the spend path passed into wasm. */
interface WasmCalls {
  keyImage: Array<{
    txPubKey: string;
    outputIndex: number;
    subaddrMajor: number | undefined;
    subaddrMinor: number | undefined;
  }>;
  signedParams: Array<Record<string, unknown>>;
}

function stubWasm(): WasmCalls {
  const calls: WasmCalls = { keyImage: [], signedParams: [] };
  const w = wasmMonero as unknown as Record<string, AnyFn>;
  w.computeKeyImage = (
    _viewKey: unknown,
    _spendKey: unknown,
    txPubKey: unknown,
    outputIndex: unknown,
    subaddrMajor: unknown,
    subaddrMinor: unknown,
  ) => {
    calls.keyImage.push({
      txPubKey: String(txPubKey),
      outputIndex: Number(outputIndex),
      subaddrMajor: subaddrMajor as number | undefined,
      subaddrMinor: subaddrMinor as number | undefined,
    });
    // Distinct per (txPubKey, index, subaddr) so nothing collides with the
    // spend_key_images filter.
    const tag = `${String(txPubKey)}:${String(outputIndex)}:${String(subaddrMajor)}:${String(subaddrMinor)}`;
    return JSON.stringify({ success: true, data: `ki-${tag}` });
  };
  w.estimateFee = () => JSON.stringify({ success: true, data: 1_000_000 });
  w.signTransaction = (paramsJson: unknown) => {
    calls.signedParams.push(JSON.parse(String(paramsJson)) as Record<string, unknown>);
    return JSON.stringify({
      success: true,
      data: { tx_hex: 'deadbeef', tx_hash: 'txhash', fee: 1_000_000 },
    });
  };
  return calls;
}

function stubLws(outputs: StubOutput[]): void {
  const decoysNeeded = 22 * outputs.length;
  chainProviders.setLws('wow', {
    asset: 'wow',
    capabilities: {
      model: 'ringct',
      feeModel: 'param-derived',
      requiresViewKey: true,
      requiresRegistration: true,
      hasDecoys: true,
      hasRecoveryScan: false,
      serverSideOutputStore: false,
    },
    async getBalance() {
      throw new Error('not used');
    },
    async listOutputs() {
      return { data: { outputs, per_byte_fee: 10, fee_mask: 10000 }, status: 200 };
    },
    async broadcast() {
      return { data: { success: true, status: 'ok' }, status: 200 };
    },
    async getHistory() {
      throw new Error('not used');
    },
    async getRandomOutputs() {
      return {
        data: {
          outputs: Array.from({ length: decoysNeeded }, (_v, i) => ({
            global_index: 9000 + i,
            public_key: `decoy${i}`,
            rct: 'rct',
          })),
        },
        status: 200,
      };
    },
    async registerAccount() {
      return { data: { success: true, message: 'ok' }, status: 200 };
    },
    async deactivateAccount() {
      return { data: { success: true, message: 'ok' }, status: 200 };
    },
    async getHeight() {
      return { data: { height: 1 }, status: 200 };
    },
    async estimateFee() {
      return { data: { model: 'param-derived' as const }, status: 200 };
    },
  });
}

const sendWow = (wallet: UnlockedWallet, amountAtomic: bigint, sweep = false) =>
  send(wallet, {
    fromAssetId: 'wow',
    amountAtomic,
    toAddress: TO_ADDRESS,
    feeRateSatPerVb: 0,
    sweep,
  });

let calls: WasmCalls;

beforeEach(() => {
  calls = stubWasm();
});

test('primary-only outputs: no subaddr index anywhere (byte-identical to the pre-subaddress path)', async () => {
  stubLws([out({ index: 0 }), out({ index: 1 })]);
  const r = await sendWow(makeWallet(), 1_000_000_000n);
  assert.equal(r.ok, true, r.ok ? '' : r.error);

  for (const c of calls.keyImage) {
    assert.equal(c.subaddrMajor, undefined, 'primary output must pass no major index');
    assert.equal(c.subaddrMinor, undefined, 'primary output must pass no minor index');
  }
  const params = calls.signedParams[0] as { inputs: Array<{ output: Record<string, unknown> }> };
  for (const i of params.inputs) {
    assert.ok(!('subaddr_index' in i.output), 'no subaddr_index key is emitted for a primary output');
  }
});

test('an explicit (0,0) is collapsed to primary, not passed through', async () => {
  stubLws([out({ index: 0, subaddr_index: { major: 0, minor: 0 } })]);
  const r = await sendWow(makeWallet(), 1_000_000_000n);
  assert.equal(r.ok, true, r.ok ? '' : r.error);

  assert.equal(calls.keyImage[0]?.subaddrMajor, undefined);
  assert.equal(calls.keyImage[0]?.subaddrMinor, undefined);
  const params = calls.signedParams[0] as { inputs: Array<{ output: Record<string, unknown> }> };
  assert.ok(!('subaddr_index' in (params.inputs[0]?.output ?? {})));
});

test('a subaddress output threads its index into BOTH the key image and the signing params', async () => {
  stubLws([out({ index: 0, subaddr_index: { major: 0, minor: 7 } })]);
  const r = await sendWow(makeWallet(), 1_000_000_000n);
  assert.equal(r.ok, true, r.ok ? '' : r.error);

  assert.deepEqual(
    calls.keyImage.map((c) => [c.subaddrMajor, c.subaddrMinor]),
    [[0, 7]],
    'computeKeyImage received the subaddress index',
  );
  const params = calls.signedParams[0] as { inputs: Array<{ output: Record<string, unknown> }> };
  assert.deepEqual(params.inputs[0]?.output.subaddr_index, { major: 0, minor: 7 });
});

test('a mixed selection keeps each input on its OWN index (no cross-contamination)', async () => {
  // Sweep so every output is selected, in a known order (largest-first).
  stubLws([
    out({ index: 0, amount: '9000000000000' }), // primary
    out({ index: 1, amount: '8000000000000', subaddr_index: { major: 0, minor: 3 } }),
    out({ index: 2, amount: '7000000000000', subaddr_index: { major: 0, minor: 11 } }),
  ]);
  const r = await sendWow(makeWallet(), 0n, true);
  assert.equal(r.ok, true, r.ok ? '' : r.error);

  // Key images are computed over the raw LWS listing, in listing order.
  assert.deepEqual(calls.keyImage.map((c) => [c.txPubKey, c.subaddrMajor, c.subaddrMinor]), [
    ['txpub0', undefined, undefined],
    ['txpub1', 0, 3],
    ['txpub2', 0, 11],
  ]);

  const params = calls.signedParams[0] as {
    inputs: Array<{ output: Record<string, unknown> }>;
  };
  const byPk = new Map(
    params.inputs.map((i) => [i.output.public_key as string, i.output.subaddr_index]),
  );
  assert.equal(byPk.get('pk0'), undefined);
  assert.deepEqual(byPk.get('pk1'), { major: 0, minor: 3 });
  assert.deepEqual(byPk.get('pk2'), { major: 0, minor: 11 });
});

test('a non-zero MAJOR index is threaded too (accounts, not just minors)', async () => {
  stubLws([out({ index: 0, subaddr_index: { major: 2, minor: 5 } })]);
  const r = await sendWow(makeWallet(), 1_000_000_000n);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.deepEqual(calls.keyImage.map((c) => [c.subaddrMajor, c.subaddrMinor]), [[2, 5]]);
  const params = calls.signedParams[0] as { inputs: Array<{ output: Record<string, unknown> }> };
  assert.deepEqual(params.inputs[0]?.output.subaddr_index, { major: 2, minor: 5 });
});

test('a malformed index falls back to primary rather than signing with garbage', async () => {
  stubLws([
    out({ index: 0, subaddr_index: { major: -1, minor: 4 } as { major: number; minor: number } }),
  ]);
  const r = await sendWow(makeWallet(), 1_000_000_000n);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.equal(calls.keyImage[0]?.subaddrMajor, undefined);
  const params = calls.signedParams[0] as { inputs: Array<{ output: Record<string, unknown> }> };
  assert.ok(!('subaddr_index' in (params.inputs[0]?.output ?? {})));
});

test('the LWS spent-key-image filter still works for a subaddress output', async () => {
  // The server reports the key image OUR subaddress-aware computation produces,
  // so the output must be filtered out as already spent. If the spend path
  // ignored the index it would compute a different key image, miss the match,
  // and try to double-spend.
  const spentKi = 'ki-txpub0:0:0:7';
  stubLws([
    out({ index: 0, subaddr_index: { major: 0, minor: 7 }, spend_key_images: [spentKi] }),
    out({ index: 1, amount: '9000000000000' }),
  ]);
  const r = await sendWow(makeWallet(), 1_000_000_000n);
  assert.equal(r.ok, true, r.ok ? '' : r.error);

  const params = calls.signedParams[0] as { inputs: Array<{ output: Record<string, unknown> }> };
  assert.deepEqual(
    params.inputs.map((i) => i.output.public_key),
    ['pk1'],
    'the already-spent subaddress output was excluded',
  );
});

test('change still goes to the PRIMARY address even when spending a subaddress output', async () => {
  stubLws([out({ index: 0, subaddr_index: { major: 0, minor: 9 } })]);
  const r = await sendWow(makeWallet(), 1_000_000_000n);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  const params = calls.signedParams[0] as { change_address: string };
  assert.equal(params.change_address, PRIMARY_WOW);
});
