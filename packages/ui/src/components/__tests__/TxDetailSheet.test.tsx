/**
 * What the transaction detail sheet tells a user, per row kind.
 *
 * `buildTxDetail` is pure, so the decisions are tested directly; one render
 * checks the sheet actually lays them out and never shows a tx key unasked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { render } from 'preact-render-to-string';

import { buildTxDetail, TxDetailSheet } from '../TxDetailSheet';
import type { AssetDetailTxRow } from '../AssetDetailScreen';

const value = (m: ReturnType<typeof buildTxDetail>, label: string) =>
  m.fields.find((f) => f.label === label)?.value;

describe('buildTxDetail: chain rows', () => {
  it('an XMR send with a send record shows the recipient and offers the tx key', () => {
    const row: AssetDetailTxRow = {
      kind: 'cryptonote',
      direction: 'out',
      amountAtomic: 1_500_000_000_000n,
      txid: 'ab'.repeat(32),
      heightOrPending: 100,
      timestamp: '2026-10-07T12:00:00Z',
      sent: {
        destination: '4ADDRESS',
        feeAtomic: 30_000_000n,
        recordedAt: '2026-10-07T11:59:00Z',
        hasTxKey: true,
      },
    };
    const m = buildTxDetail(row, 'xmr', { explorerAvailable: true, tipHeight: 109 });
    assert.equal(m.title, 'Sent XMR');
    assert.equal(value(m, 'Sent to'), '4ADDRESS');
    assert.equal(value(m, 'Status'), '10 confirmations (block #100)');
    assert.ok(value(m, 'Network fee')?.endsWith('XMR'));
    assert.ok(m.fields.find((f) => f.label === 'Transaction ID')?.copyable);
    assert.deepEqual(m.actions, ['explorer', 'reveal-tx-key']);
    assert.equal(m.note, undefined);
  });

  it('an XMR send without a record says the recipient is unknown, and offers no key', () => {
    const row: AssetDetailTxRow = {
      kind: 'cryptonote',
      direction: 'out',
      amountAtomic: 1n,
      txid: 'cd'.repeat(32),
      heightOrPending: 'pending',
      timestamp: '2026-10-07T12:00:00Z',
    };
    const m = buildTxDetail(row, 'xmr');
    assert.equal(value(m, 'Sent to'), undefined);
    assert.equal(value(m, 'Status'), 'Unconfirmed (in mempool)');
    assert.ok(!m.actions.includes('reveal-tx-key'));
    assert.match(m.note ?? '', /recipient is not known/);
  });

  it('a subaddress send with no verified key explains why', () => {
    const row: AssetDetailTxRow = {
      kind: 'cryptonote',
      direction: 'out',
      amountAtomic: 1n,
      txid: 'ef'.repeat(32),
      heightOrPending: 5,
      timestamp: '2026-10-07T12:00:00Z',
      sent: { destination: '8SUB', recordedAt: '2026-10-07T12:00:00Z', hasTxKey: false },
    };
    const m = buildTxDetail(row, 'wow');
    assert.ok(!m.actions.includes('reveal-tx-key'));
    assert.match(m.note ?? '', /subaddress/);
  });

  it('a BTC row without a block time falls back to the recorded send time', () => {
    const row: AssetDetailTxRow = {
      kind: 'utxo',
      direction: 'out',
      amountAtomic: 5000n,
      txid: '01'.repeat(32),
      heightOrPending: 7,
      sent: { destination: 'bc1qdest', recordedAt: '2026-10-01T00:00:00Z', hasTxKey: false },
    };
    const m = buildTxDetail(row, 'btc');
    assert.ok(value(m, 'Time'));
    assert.equal(value(m, 'Sent to'), 'bc1qdest');
    assert.equal(value(m, 'Status'), 'Block #7');
  });
  it('a mined swap deposit still names its swap, and offers both the swap and the explorer', () => {
    const row: AssetDetailTxRow = {
      kind: 'utxo',
      direction: 'out',
      amountAtomic: 5154n,
      txid: '02'.repeat(32),
      heightOrPending: 7,
      context: { kind: 'swap-deposit', tradeId: 'T9', toAsset: 'xmr', provider: 'trocador' },
    };
    const m = buildTxDetail(row, 'btc', { explorerAvailable: true, tipHeight: 7 });
    assert.equal(value(m, 'Trade ID'), 'T9');
    assert.match(value(m, 'Swap') ?? '', /XMR/);
    assert.ok(m.actions.includes('open-swap'));
    assert.ok(m.actions.includes('explorer'));
    assert.equal(value(m, 'Status'), '1 confirmation (block #7)');
  });

  it('a recipient known only in flight says nothing about a transaction key', () => {
    const row: AssetDetailTxRow = {
      kind: 'cryptonote',
      direction: 'out',
      amountAtomic: 1n,
      txid: '03'.repeat(32),
      heightOrPending: 'pending',
      timestamp: '2026-10-07T12:00:00Z',
      sent: { destination: '4BOB', recordedAt: '2026-10-07T12:00:00Z', hasTxKey: false, fromInFlight: true },
    };
    const m = buildTxDetail(row, 'xmr');
    assert.equal(value(m, 'Sent to'), '4BOB');
    assert.ok(!m.actions.includes('reveal-tx-key'));
    assert.doesNotMatch(m.note ?? '', /subaddress/);
  });
});

describe('buildTxDetail: other rows', () => {
  it('a swap deposit offers the swap status, not an explorer the shell lacks', () => {
    const row: AssetDetailTxRow = {
      kind: 'pending-outgoing',
      txid: 'aa'.repeat(32),
      amountAtomic: 10n,
      feeAtomic: 1n,
      recipient: 'deposit-address',
      submittedAt: '2026-10-07T12:00:00Z',
      context: { kind: 'swap-deposit', tradeId: 'T1', toAsset: 'btc', provider: 'trocador' },
    };
    const m = buildTxDetail(row, 'xmr', { explorerAvailable: false });
    assert.deepEqual(m.actions, ['open-swap']);
    assert.equal(value(m, 'Trade ID'), 'T1');
  });

  it('a sent tip shows its lifecycle times and a truthful expiry note', () => {
    const row: AssetDetailTxRow = {
      kind: 'tip-sent',
      tipId: 'tip-1',
      amountAtomic: 100n,
      ticker: 'LTC',
      counterparty: 'public link',
      timestamp: '2026-10-01T00:00:00Z',
      status: 'clawed_back',
      clawedBackAt: '2026-10-02T00:00:00Z',
      isPublic: true,
      hasLocalBackup: true,
    };
    const m = buildTxDetail(row, 'ltc');
    assert.equal(value(m, 'Status'), 'Returned to sender');
    assert.equal(value(m, 'To'), 'Anyone with the link');
    assert.ok(value(m, 'Returned to you'));
    assert.equal(value(m, 'Claimed'), undefined);
    assert.match(m.note ?? '', /no expiry date/);
  });

  it('a received tip awaiting confirmations shows its funding progress', () => {
    const row: AssetDetailTxRow = {
      kind: 'tip-received',
      tipId: 'tip-2',
      amountAtomic: 1n,
      ticker: 'BTC',
      counterparty: '@alice',
      timestamp: '2026-10-01T00:00:00Z',
      status: 'pending',
      fundingConfirmations: 1,
      confirmationsRequired: 3,
    };
    const m = buildTxDetail(row, 'btc');
    assert.equal(value(m, 'Funding'), '1 of 3 confirmations');
    assert.equal(value(m, 'From'), '@alice');
  });
});

describe('TxDetailSheet render', () => {
  it('lays out the fields and offers the key behind a button, never inline', () => {
    const row: AssetDetailTxRow = {
      kind: 'cryptonote',
      direction: 'out',
      amountAtomic: 2n,
      txid: '99'.repeat(32),
      heightOrPending: 3,
      timestamp: '2026-10-07T12:00:00Z',
      sent: { destination: '4DEST', recordedAt: '2026-10-07T12:00:00Z', hasTxKey: true },
    };
    const html = render(
      h(TxDetailSheet, {
        model: buildTxDetail(row, 'xmr', { explorerAvailable: true }),
        onClose: () => undefined,
        onOpenExplorer: () => undefined,
        onRevealTxKey: async () => 'secret-key-hex',
      }),
    );
    assert.match(html, /4DEST/);
    assert.match(html, /Show transaction key/);
    assert.match(html, /View in block explorer/);
    assert.doesNotMatch(html, /secret-key-hex/);
  });
});
