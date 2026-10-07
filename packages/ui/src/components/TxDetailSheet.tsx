/**
 * TxDetailSheet: the in-wallet answer to "what was this transaction?".
 *
 * Until v0.3.1 a history row only knew how to open an external explorer, and
 * on desktop not even that. An explorer cannot say who a Monero payment went
 * to, and nothing on chain can: only the wallet's own send record can. So the
 * sheet shows what the chain row carries, what the wallet recorded when it
 * signed (destination, fee, time), and, on request, the transaction key a
 * payment proof is checked against.
 *
 * `buildTxDetail` is a pure function of the row so the decision of what a user
 * sees is testable without rendering; the component only lays it out.
 */

import { useState } from 'preact/hooks';
import { formatAmount } from '../format';
import { copyText } from '../clipboard';
import type { AssetDetailTxRow } from './AssetDetailScreen';

export interface TxDetailField {
  label: string;
  value: string;
  /** Long identifiers (txid, address, key) render monospace, wrapped, copyable. */
  copyable?: boolean;
}

/** Things the sheet can offer beyond reading. */
export type TxDetailAction = 'explorer' | 'reveal-tx-key' | 'open-swap';

export interface TxDetailModel {
  title: string;
  fields: TxDetailField[];
  actions: TxDetailAction[];
  /** One line of honest context when something a user may expect is missing. */
  note?: string;
}

function fmtTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleString();
}

function tipStatus(status: string | undefined): string {
  switch (status) {
    case 'pending_confirmation':
      return 'Confirming';
    case 'pending':
      return 'Awaiting claim';
    case 'claiming':
      return 'Claiming';
    case 'claimed':
      return 'Claimed';
    case 'clawed_back':
      return 'Returned to sender';
    case 'funding_mismatch':
      return 'Underfunded';
    case 'draft':
      return 'Draft';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status ?? 'Unknown';
  }
}

/**
 * Describe a row. `explorerAvailable` says whether the shell has a URL for it;
 * `tipHeight` (the chain's current height, when known) turns a block height
 * into a confirmation count.
 */
export function buildTxDetail(
  row: AssetDetailTxRow,
  assetId: string,
  opts: { explorerAvailable?: boolean; tipHeight?: number } = {},
): TxDetailModel {
  const ticker = assetId.toUpperCase();
  const amt = (v: bigint) => `${formatAmount(v, assetId, 12)} ${ticker}`;
  const fields: TxDetailField[] = [];
  const actions: TxDetailAction[] = [];
  const push = (label: string, value: string | null | undefined, copyable = false) => {
    if (value !== null && value !== undefined && value !== '') {
      fields.push({ label, value, ...(copyable ? { copyable } : {}) });
    }
  };
  const confirmations = (h: number | 'pending'): string => {
    if (h === 'pending') return 'Unconfirmed (in mempool)';
    if (opts.tipHeight !== undefined && opts.tipHeight >= h) {
      const n = opts.tipHeight - h + 1;
      return `${n} confirmation${n === 1 ? '' : 's'} (block #${h})`;
    }
    return `Block #${h}`;
  };

  switch (row.kind) {
    case 'utxo':
    case 'cryptonote': {
      const out = row.direction === 'out';
      push('Direction', out ? 'Sent' : 'Received');
      if (row.amountAtomic !== undefined) push('Amount', amt(row.amountAtomic));
      const fee = row.sent?.feeAtomic ?? (row.kind === 'utxo' ? row.feeAtomic : undefined);
      if (fee !== undefined) push('Network fee', amt(fee));
      push('Time', fmtTime(row.timestamp) ?? fmtTime(row.sent?.recordedAt));
      push('Status', confirmations(row.heightOrPending));
      if (row.sent) push('Sent to', row.sent.destination, true);
      push('Transaction ID', row.txid, true);
      if (opts.explorerAvailable) actions.push('explorer');
      if (row.sent?.hasTxKey) actions.push('reveal-tx-key');
      let note: string | undefined;
      if (out && !row.sent) {
        note =
          row.kind === 'cryptonote'
            ? 'This wallet has no send record for this payment (sent before v0.3.1 or from another device), so the recipient is not known. The chain does not record it.'
            : 'This wallet has no send record for this payment, so the recipient shown by an explorer may be a change address.';
      } else if (row.kind === 'cryptonote' && row.sent && !row.sent.hasTxKey) {
        note = 'No transaction key on file: subaddress payments use per-output keys, which this wallet does not store yet.';
      } else if (row.timestamp === undefined && !row.sent) {
        note = 'Block time is not available for this transaction yet.';
      }
      return {
        title: out ? `Sent ${ticker}` : `Received ${ticker}`,
        fields,
        actions,
        ...(note ? { note } : {}),
      };
    }
    case 'grin': {
      const out = row.direction === 'out';
      push('Direction', out ? 'Sent' : 'Received');
      push('Amount', amt(row.amountAtomic));
      push('Network fee', amt(row.feeAtomic));
      push('Time', fmtTime(row.timestamp));
      push('Status', row.status);
      if (row.counterpartyUsername) push(out ? 'Sent to' : 'From', `@${row.counterpartyUsername}`);
      push('Kernel', row.kernelExcess, true);
      push('Slate ID', row.slateId, true);
      if (opts.explorerAvailable) actions.push('explorer');
      return { title: out ? 'Sent GRIN' : 'Received GRIN', fields, actions };
    }
    case 'pending-outgoing': {
      push('Direction', 'Sent');
      push('Amount', amt(row.amountAtomic));
      push('Network fee', amt(row.feeAtomic));
      push('Time', fmtTime(row.submittedAt));
      push('Status', 'Broadcast, waiting for confirmation');
      if (row.context?.kind === 'swap-deposit') {
        push('Swap', `${ticker} to ${row.context.toAsset.toUpperCase()} via ${row.context.provider}`);
        push('Trade ID', row.context.tradeId, true);
        actions.push('open-swap');
      } else if (row.context?.kind === 'tip-fund') {
        push('Funding tip', row.context.tipId, true);
      }
      push('Sent to', row.recipient, true);
      push('Transaction ID', row.txid, true);
      if (opts.explorerAvailable) actions.push('explorer');
      return { title: `Sending ${ticker}`, fields, actions };
    }
    case 'tip-sent': {
      push('Amount', amt(row.amountAtomic));
      push('Status', tipStatus(row.status));
      push('To', row.isPublic ? 'Anyone with the link' : row.counterparty);
      push('Created', fmtTime(row.timestamp));
      if (
        row.fundingConfirmations !== undefined &&
        row.confirmationsRequired !== undefined &&
        row.status === 'pending_confirmation'
      ) {
        push('Funding', `${row.fundingConfirmations} of ${row.confirmationsRequired} confirmations`);
      }
      push('Claimed', fmtTime(row.claimedAt));
      push('Returned to you', fmtTime(row.clawedBackAt));
      push('Local recovery copy', row.hasLocalBackup ? 'Yes, on this device' : null);
      push('Tip ID', row.tipId, true);
      return {
        title: `Tip sent, ${ticker}`,
        fields,
        actions,
        note:
          row.status === 'draft'
            ? 'A draft that is never funded is cancelled after 7 days.'
            : 'Tips carry no expiry date: an unclaimed tip stays claimable until it is claimed or you take it back.',
      };
    }
    case 'tip-received': {
      push('Amount', amt(row.amountAtomic));
      push('Status', tipStatus(row.status));
      push('From', row.counterparty);
      push('Received', fmtTime(row.timestamp));
      if (
        row.fundingConfirmations !== undefined &&
        row.confirmationsRequired !== undefined &&
        (row.status === 'pending' || row.status === 'pending_confirmation')
      ) {
        push('Funding', `${row.fundingConfirmations} of ${row.confirmationsRequired} confirmations`);
      }
      push('Claimed', fmtTime(row.claimedAt));
      push('Taken back by sender', fmtTime(row.clawedBackAt));
      push('Tip ID', row.tipId, true);
      return { title: `Tip received, ${ticker}`, fields, actions };
    }
  }
}

export function TxDetailSheet({
  model,
  onClose,
  onOpenExplorer,
  onOpenSwap,
  onRevealTxKey,
}: {
  model: TxDetailModel;
  onClose: () => void;
  onOpenExplorer?: () => void;
  onOpenSwap?: () => void;
  /** Resolve the transaction key, or null when none is on file or the wallet is locked. */
  onRevealTxKey?: () => Promise<string | null>;
}) {
  const [txKey, setTxKey] = useState<string | null>(null);
  const [txKeyMsg, setTxKeyMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (label: string, value: string) => {
    try {
      await copyText(value);
      setCopied(label);
    } catch {
      setCopied(null);
    }
  };

  const reveal = async () => {
    if (!onRevealTxKey) return;
    const k = await onRevealTxKey();
    if (k) {
      setTxKey(k);
      setTxKeyMsg(null);
    } else {
      setTxKeyMsg('Transaction key unavailable. Unlock the wallet and try again.');
    }
  };

  const linkButton = {
    background: 'transparent',
    border: '1px solid var(--smirk-border)',
    borderRadius: 'var(--smirk-radius, 8px)',
    color: 'inherit',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 12,
    padding: '6px 10px',
  } as const;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={model.title}
      data-testid="tx-detail-sheet"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--smirk-bg)',
          border: '1px solid var(--smirk-border)',
          borderRadius: 'var(--smirk-radius, 8px) var(--smirk-radius, 8px) 0 0',
          boxSizing: 'border-box',
          maxHeight: '85%',
          overflowY: 'auto',
          padding: 14,
          width: '100%',
          maxWidth: 520,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <strong style={{ fontSize: 14, flex: 1 }}>{model.title}</strong>
          <button data-testid="tx-detail-close" onClick={onClose} style={linkButton}>
            Close
          </button>
        </div>
        <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {model.fields.map((f) => (
            <div key={f.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <dt style={{ fontSize: 10, color: 'var(--smirk-fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {f.label}
              </dt>
              <dd
                style={{
                  margin: 0,
                  fontSize: 12,
                  wordBreak: f.copyable ? 'break-all' : 'normal',
                  fontFamily: f.copyable ? 'var(--smirk-font-mono, monospace)' : 'inherit',
                  display: 'flex',
                  gap: 8,
                  alignItems: 'flex-start',
                }}
              >
                <span style={{ flex: 1 }}>{f.value}</span>
                {f.copyable && (
                  <button style={linkButton} onClick={() => void copy(f.label, f.value)}>
                    {copied === f.label ? 'Copied' : 'Copy'}
                  </button>
                )}
              </dd>
            </div>
          ))}
          {txKey && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <dt style={{ fontSize: 10, color: 'var(--smirk-fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Transaction key (secret)
              </dt>
              <dd style={{ margin: 0, fontSize: 12, wordBreak: 'break-all', fontFamily: 'var(--smirk-font-mono, monospace)', display: 'flex', gap: 8 }}>
                <span style={{ flex: 1 }} data-testid="tx-detail-tx-key">{txKey}</span>
                <button style={linkButton} onClick={() => void copy('tx-key', txKey)}>
                  {copied === 'tx-key' ? 'Copied' : 'Copy'}
                </button>
              </dd>
              <span style={{ fontSize: 11, color: 'var(--smirk-fg-muted)' }}>
                Anyone with this key, the transaction ID and the recipient address can confirm this payment and its amount. Share it only to prove a payment.
              </span>
            </div>
          )}
        </dl>
        {model.note && (
          <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)' }}>{model.note}</div>
        )}
        {txKeyMsg && <div style={{ fontSize: 11, color: 'var(--smirk-negative)' }}>{txKeyMsg}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {model.actions.includes('reveal-tx-key') && !txKey && onRevealTxKey && (
            <button data-testid="tx-detail-reveal-key" style={linkButton} onClick={() => void reveal()}>
              Show transaction key
            </button>
          )}
          {model.actions.includes('open-swap') && onOpenSwap && (
            <button style={linkButton} onClick={onOpenSwap}>
              Open swap status
            </button>
          )}
          {model.actions.includes('explorer') && onOpenExplorer && (
            <button data-testid="tx-detail-explorer" style={linkButton} onClick={onOpenExplorer}>
              View in block explorer
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
