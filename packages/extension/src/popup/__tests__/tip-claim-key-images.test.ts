import './_chrome-stub';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { monero } from '@smirk/wasm';
import { proveTipKeyImages } from '../tip-claim-handler';

/**
 * The XMR/WOW sweep report carries the key image of each tip output the sweep
 * spent, with a proof bound to the tip (the backend settles on the transaction
 * that spends it, never on a ring decoy). The proof is best effort: a claim
 * never fails because one could not be made.
 */

const OUTPUTS = [
  { tx_pub_key: 'aa'.repeat(32), index: 0, public_key: 'bb'.repeat(32) },
  { tx_pub_key: 'cc'.repeat(32), index: 3, public_key: 'dd'.repeat(32) },
];

function wasmOk(data: unknown): string {
  return JSON.stringify({ success: true, data });
}

test('each spent output is proven for the claimed tip with the tip keys', () => {
  const prove = mock.method(
    monero,
    'proveTipKeyImage',
    (view: string, spend: string, txPub: string, index: number, outputKey: string, tipId: string) =>
      wasmOk({ output_key: outputKey, key_image: `ki-${index}`, proof: `${view}${spend}${tipId}`.slice(0, 8) }),
  );
  try {
    const proofs = proveTipKeyImages('vk', 'sk', OUTPUTS, 'tip-42');
    assert.deepEqual(
      proofs?.map((p) => [p.output_key, p.key_image]),
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

test('an output that cannot be proven is left out, and none at all means no key images', () => {
  let call = 0;
  const prove = mock.method(monero, 'proveTipKeyImage', () => {
    call += 1;
    return call === 1
      ? JSON.stringify({ success: false, error: 'Output one-time key mismatch' })
      : wasmOk({ output_key: 'dd'.repeat(32), key_image: 'ki', proof: 'p' });
  });
  const warn = mock.method(console, 'warn', () => {});
  try {
    assert.equal(proveTipKeyImages('vk', 'sk', OUTPUTS, 'tip')?.length, 1);
    prove.mock.mockImplementation(() => {
      throw new Error('wasm not loaded');
    });
    assert.equal(proveTipKeyImages('vk', 'sk', OUTPUTS, 'tip'), undefined);
  } finally {
    prove.mock.restore();
    warn.mock.restore();
  }
});
