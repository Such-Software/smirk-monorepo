import './_chrome-stub';
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  api,
  chainProviders,
  createPublicTipPayload,
  generateUrlFragmentKey,
  type LwsChainProvider,
  type LwsHistoryEntry,
  type LwsUnspentOutput,
  type TipSweepKeyImage,
  type UnlockedWallet,
} from '@smirk/core';
import { monero } from '@smirk/wasm';
import { walletKeystore } from '../singletons';
import {
  claimPublicTip,
  MAX_REPORTED_KEY_IMAGES,
  proveTipKeyImages,
  sweepCryptonoteKeys,
} from '../tip-claim-handler';

/**
 * The XMR/WOW sweep report carries the key image of each tip output the sweep
 * spent, with a proof bound to the tip. The backend settles an XMR/WOW tip on
 * nothing else (a txid alone could be a ring decoy), so every report carries
 * them: a claim whose outputs cannot be proven signs and sends nothing.
 *
 * A claim an older wallet sent (v0.3.0 reported its sweep by txid alone) is
 * proven when the tip is reopened, and shown as "Claim sent, confirming".
 */

const OUTPUTS = [
  { tx_pub_key: 'aa'.repeat(32), index: 0, public_key: 'bb'.repeat(32) },
  { tx_pub_key: 'cc'.repeat(32), index: 3, public_key: 'dd'.repeat(32) },
];

function wasmOk(data: unknown): string {
  return JSON.stringify({ success: true, data });
}

/** A stand-in prover: one deterministic proof per output, bound to the tip id. */
function fakeProof(_view: string, _spend: string, _txPub: string, index: number, outputKey: string, tipId: string) {
  return wasmOk({ output_key: outputKey, key_image: `ki-${index}`, proof: `proof-${tipId}` });
}

test('each spent output is proven for the claimed tip with the tip keys', () => {
  const prove = mock.method(monero, 'proveTipKeyImage', fakeProof);
  try {
    const proofs = proveTipKeyImages('vk', 'sk', OUTPUTS, 'tip-42');
    assert.deepEqual(
      proofs.map((p) => [p.output_key, p.key_image]),
      [
        ['bb'.repeat(32), 'ki-0'],
        ['dd'.repeat(32), 'ki-3'],
      ],
    );
    assert.deepEqual(
      prove.mock.calls.map((c) => c.arguments),
      [
        ['vk', 'sk', 'aa'.repeat(32), 0, 'bb'.repeat(32), 'tip-42'],
        ['vk', 'sk', 'cc'.repeat(32), 3, 'dd'.repeat(32), 'tip-42'],
      ],
    );
  } finally {
    prove.mock.restore();
  }
});

test('an output that cannot be proven fails the proof, and so does having none', () => {
  let call = 0;
  const prove = mock.method(monero, 'proveTipKeyImage', () => {
    call += 1;
    return call === 1
      ? JSON.stringify({ success: false, error: 'Output one-time key mismatch' })
      : wasmOk({ output_key: 'dd'.repeat(32), key_image: 'ki', proof: 'p' });
  });
  try {
    assert.throws(() => proveTipKeyImages('vk', 'sk', OUTPUTS, 'tip'), /mismatch/);
    assert.throws(() => proveTipKeyImages('vk', 'sk', [], 'tip'), /no tip outputs/);
  } finally {
    prove.mock.restore();
  }
});

test('a report proves at most sixteen outputs, the largest first', () => {
  const prove = mock.method(monero, 'proveTipKeyImage', fakeProof);
  try {
    // The funding output among twenty dust outputs someone sent to the public
    // tip address: the backend reads only the first sixteen proofs.
    const dust = Array.from({ length: 20 }, (_v, i) => ({
      tx_pub_key: `dust${i}`,
      index: i + 1,
      public_key: `dust-key-${i}`,
      amount: String(1_000 + i),
    }));
    const funding = { tx_pub_key: 'funding', index: 0, public_key: 'funding-key', amount: '300000000000' };
    const proofs = proveTipKeyImages('vk', 'sk', [...dust, funding], 'tip');
    assert.equal(proofs.length, MAX_REPORTED_KEY_IMAGES);
    assert.equal(proofs[0]!.output_key, 'funding-key');
    assert.ok(!proofs.some((p) => p.output_key === 'dust-key-0'), 'the smallest dust is left out');
  } finally {
    prove.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// The sweep itself, against a stubbed light-wallet server and signer.
// ---------------------------------------------------------------------------

const TIP_ADDRESS = 'Wo-tip-address';
const OWN_ADDRESS = 'Wo-own-address';
const EARLIER_SWEEP = 'ee'.repeat(32);

function makeWallet(): UnlockedWallet {
  const cn = {
    privateSpendKey: new Uint8Array(32).fill(3),
    privateViewKey: new Uint8Array(32).fill(7),
    publicSpendKey: new Uint8Array(32).fill(5),
    publicViewKey: new Uint8Array(32).fill(9),
  };
  return {
    fingerprint: 'fp-claim',
    keys: { wow: cn, xmr: cn },
    addresses: { wow: OWN_ADDRESS, xmr: '4own' },
  } as unknown as UnlockedWallet;
}

function tipOutput(index: number, amount = '300000000000'): LwsUnspentOutput {
  return {
    amount,
    public_key: `tip-out-${index}`,
    tx_pub_key: `tip-txpub-${index}`,
    index,
    global_index: 5_000 + index,
    height: 880_142,
    rct: 'rct',
    spend_key_images: [],
  };
}

interface LwsRecord {
  broadcasts: string[];
  historyReads: string[];
  decoyFetches: number;
}

function stubLws(outputs: LwsUnspentOutput[], ownHistory: LwsHistoryEntry[]): LwsRecord {
  const rec: LwsRecord = { broadcasts: [], historyReads: [], decoyFetches: 0 };
  const provider = {
    asset: 'wow',
    async listOutputs(address: string) {
      assert.equal(address, TIP_ADDRESS);
      return { data: { outputs, per_byte_fee: 10, fee_mask: 10_000 }, status: 200 };
    },
    async getHistory(address: string) {
      rec.historyReads.push(address);
      return {
        data: { asset: 'wow', transactions: ownHistory, scanned_height: 1, blockchain_height: 1 },
        status: 200,
      };
    },
    async getRandomOutputs(count: number) {
      rec.decoyFetches += 1;
      return {
        data: {
          outputs: Array.from({ length: count }, (_v, i) => ({ global_index: 9_000 + i, public_key: `decoy${i}`, rct: 'rct' })),
        },
        status: 200,
      };
    },
    async broadcast(txHex: string) {
      rec.broadcasts.push(txHex);
      return { data: { success: true, status: 'ok' }, status: 200 };
    },
    async deactivateAccount() {
      return { data: { success: true, message: 'ok' }, status: 200 };
    },
  } as unknown as LwsChainProvider;
  chainProviders.setLws('wow', provider);
  return rec;
}

function paidOwnWallet(txid: string, received: string): LwsHistoryEntry {
  return {
    txid,
    height: 880_900,
    timestamp: '2026-10-09T00:00:00Z',
    is_pending: false,
    total_received: received,
    spent_outputs: [],
  };
}

let restoreLws: LwsChainProvider;
let signed: number;
const mocks: Array<{ mock: { restore(): void } }> = [];

beforeEach(() => {
  restoreLws = chainProviders.lws('wow');
  signed = 0;
  mocks.push(mock.method(walletKeystore, 'assertUnlockedWallet', () => undefined));
  mocks.push(
    mock.method(monero, 'computeKeyImage', (_v: string, _s: string, _t: string, index: number) => wasmOk(`own-ki-${index}`)),
  );
  mocks.push(mock.method(monero, 'estimateFee', () => wasmOk(1_000_000)));
  mocks.push(
    mock.method(monero, 'signTransaction', () => {
      signed += 1;
      return wasmOk({ tx_hex: 'deadbeef', tx_hash: 'ab'.repeat(32), fee: 1_000_000 });
    }),
  );
});

afterEach(() => {
  chainProviders.setLws('wow', restoreLws);
  while (mocks.length > 0) mocks.pop()!.mock.restore();
});

test('a sweep whose tip outputs cannot be proven signs and sends nothing', async () => {
  const lws = stubLws([tipOutput(0)], []);
  mocks.push(mock.method(monero, 'proveTipKeyImage', () => JSON.stringify({ success: false, error: 'key mismatch' })));
  const r = await sweepCryptonoteKeys('wow', new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), TIP_ADDRESS, makeWallet(), {
    proveForTipId: 'tip-1',
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /nothing was sent/);
  assert.equal(signed, 0);
  assert.deepEqual(lws.broadcasts, []);
  assert.equal(lws.decoyFetches, 0, 'it stops before the decoy fetch');
});

test('every XMR/WOW claim sweep comes back with the proofs for its report', async () => {
  const lws = stubLws([tipOutput(0)], []);
  mocks.push(mock.method(monero, 'proveTipKeyImage', fakeProof));
  const r = await sweepCryptonoteKeys('wow', new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), TIP_ADDRESS, makeWallet(), {
    proveForTipId: 'tip-1',
  });
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  if (r.ok) {
    assert.deepEqual(r.keyImages?.map((k) => k.output_key), ['tip-out-0']);
    assert.equal(r.confirming, undefined, 'a fresh sweep is not a resent claim');
  }
  assert.equal(signed, 1);
  assert.equal(lws.broadcasts.length, 1);
});

test('a claim this wallet already sent is proven and resent, never swept twice', async () => {
  // v0.3.0 swept the tip into this wallet and reported the txid alone. The
  // light-wallet server stopped scanning the tip address right after, so it
  // still lists the output unspent: a second sweep would be a double spend.
  const lws = stubLws([tipOutput(0)], [paidOwnWallet(EARLIER_SWEEP, '299990000000')]);
  mocks.push(mock.method(monero, 'proveTipKeyImage', fakeProof));
  const r = await sweepCryptonoteKeys('wow', new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), TIP_ADDRESS, makeWallet(), {
    proveForTipId: 'tip-1',
    earlierSweepTxid: EARLIER_SWEEP.toUpperCase(),
  });
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  if (r.ok) {
    assert.equal(r.txid, EARLIER_SWEEP);
    assert.equal(r.confirming, true);
    assert.equal(r.amountAtomic, 299_990_000_000n);
    assert.deepEqual(r.keyImages?.map((k) => k.output_key), ['tip-out-0']);
  }
  assert.deepEqual(lws.historyReads, [OWN_ADDRESS], "only this wallet's own history is read");
  assert.equal(signed, 0);
  assert.deepEqual(lws.broadcasts, []);
  assert.equal(lws.decoyFetches, 0);
});

test('an earlier sweep that never paid this wallet is swept as usual', async () => {
  const lws = stubLws([tipOutput(0)], [paidOwnWallet('ff'.repeat(32), '5')]);
  mocks.push(mock.method(monero, 'proveTipKeyImage', fakeProof));
  const r = await sweepCryptonoteKeys('wow', new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), TIP_ADDRESS, makeWallet(), {
    proveForTipId: 'tip-1',
    earlierSweepTxid: EARLIER_SWEEP,
  });
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  if (r.ok) assert.equal(r.confirming, undefined);
  assert.equal(signed, 1);
  assert.equal(lws.broadcasts.length, 1);
});

test('reopening a link tip claimed by an older wallet shows "claim sent, confirming" and reports the proof', async () => {
  const fragment = generateUrlFragmentKey();
  const tipSpendKey = new Uint8Array(32).fill(4);
  const lws = stubLws([tipOutput(0)], [paidOwnWallet(EARLIER_SWEEP, '299990000000')]);
  mocks.push(mock.method(monero, 'proveTipKeyImage', fakeProof));
  mocks.push(
    mock.method(api, 'getPublicSocialTip', async () => ({
      data: {
        id: 'tip-9',
        asset: 'wow',
        amount: 300_000_000_000,
        status: 'claiming',
        created_at: '2026-10-08T00:00:00Z',
        is_public: true,
        encrypted_key: createPublicTipPayload(tipSpendKey, fragment.bytes),
        tip_address: TIP_ADDRESS,
        funding_confirmations: 4,
        confirmations_required: 4,
        is_claimable: true,
      },
      status: 200,
    })),
  );
  mocks.push(
    mock.method(api, 'claimSocialTip', async () => ({
      data: { success: true, encrypted_key: null, tip_address: TIP_ADDRESS, reported_sweep_txid: EARLIER_SWEEP },
      status: 200,
    })),
  );
  const reports: Array<{ tipId: string; txid: string; keyImages: TipSweepKeyImage[] | undefined }> = [];
  mocks.push(
    mock.method(api, 'confirmTipSweep', async (tipId: string, txid: string, keyImages?: TipSweepKeyImage[]) => {
      reports.push({ tipId, txid, keyImages });
      return { data: { sweep_txid: txid, status: 'claiming' }, status: 200 };
    }),
  );

  const r = await claimPublicTip(makeWallet(), 'user-1', 'tip-9', fragment.encoded);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  if (r.ok) assert.equal(r.confirming, true);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.txid, EARLIER_SWEEP);
  assert.deepEqual(reports[0]!.keyImages?.map((k) => k.proof), ['proof-tip-9']);
  assert.equal(signed, 0);
  assert.deepEqual(lws.broadcasts, []);
});
