/**
 * TipDetailSheet: everything about one tip, sent or received, in one place.
 *
 * Shows who, how much, the message, when it was made, the claim-by date, and
 * a status timeline: funded, confirming, claimable, then claimed or
 * reclaimed. Actions (claim, reclaim, copy link) are passed in by the caller,
 * so the same sheet serves the Inbox, Tips sent, and coin activity.
 */

import type { ComponentChildren } from 'preact';
import { mustGetAsset } from '@smirk/assets';
import { formatAmount } from '../format';
import { AssetIcon } from './AssetIcon';

export interface TipDetail {
  tipId: string;
  direction: 'sent' | 'received';
  assetId: string;
  /** Atomic units. */
  amount: number | bigint;
  /** "@alice", "npub1abcd…wxyz", or "link". */
  counterparty: string;
  memo?: string;
  createdAt: string;
  expiresAt?: string;
  /** Backend status: draft, pending_confirmation, pending, claiming, claimed,
   *  clawed_back, cancelled, funding_mismatch. */
  status: string;
  fundingConfirmations: number;
  confirmationsRequired: number;
}

export type TimelineState = 'done' | 'current' | 'todo' | 'failed';
export interface TimelineStep {
  label: string;
  state: TimelineState;
  detail?: string;
}

/** The status timeline for a tip. Pure, so it is unit-tested apart from the UI. */
export function tipTimeline(t: Pick<TipDetail, 'status' | 'fundingConfirmations' | 'confirmationsRequired'>): TimelineStep[] {
  const confirmed = t.fundingConfirmations >= Math.max(1, t.confirmationsRequired);
  const confDetail = `${Math.min(t.fundingConfirmations, t.confirmationsRequired)}/${t.confirmationsRequired}`;
  switch (t.status) {
    case 'draft':
      return [
        { label: 'Created', state: 'done' },
        { label: 'Funded', state: 'current', detail: 'not funded yet' },
        { label: 'Confirmed', state: 'todo' },
        { label: 'Claimed', state: 'todo' },
      ];
    case 'claimed':
      return [
        { label: 'Funded', state: 'done' },
        { label: 'Confirmed', state: 'done' },
        { label: 'Claimed', state: 'done' },
      ];
    case 'clawed_back':
      return [
        { label: 'Funded', state: 'done' },
        { label: 'Confirmed', state: 'done' },
        { label: 'Reclaimed', state: 'done', detail: 'returned to the sender' },
      ];
    case 'cancelled':
      return [
        { label: 'Created', state: 'done' },
        { label: 'Cancelled', state: 'failed' },
      ];
    case 'funding_mismatch':
      return [
        { label: 'Funded', state: 'failed', detail: 'less than the tip amount' },
        { label: 'Confirmed', state: 'todo' },
        { label: 'Claimed', state: 'todo' },
      ];
    case 'claiming':
      return [
        { label: 'Funded', state: 'done' },
        { label: 'Confirmed', state: 'done' },
        { label: 'Claiming', state: 'current' },
      ];
    default:
      // pending_confirmation and pending: funded, then waiting on the chain,
      // then waiting on the recipient.
      return [
        { label: 'Funded', state: 'done' },
        { label: 'Confirmed', state: confirmed ? 'done' : 'current', detail: confDetail },
        confirmed
          ? { label: 'Claimed', state: 'current', detail: 'ready to claim' }
          : { label: 'Claimed', state: 'todo' },
      ];
  }
}

export interface TipDetailSheetProps {
  tip: TipDetail;
  /** Action buttons for this tip (claim, reclaim, copy link). */
  actions?: ComponentChildren;
  onClose: () => void;
  resolveIcon?: (key: string) => string | undefined;
}

const STEP_COLOR: Record<TimelineState, string> = {
  done: 'var(--smirk-positive)',
  current: 'var(--smirk-accent)',
  todo: 'var(--smirk-fg-muted)',
  failed: 'var(--smirk-negative, #ff6b6b)',
};
const STEP_MARK: Record<TimelineState, string> = { done: '●', current: '◐', todo: '○', failed: '✕' };

export function TipDetailSheet({ tip, actions, onClose, resolveIcon }: TipDetailSheetProps) {
  const asset = mustGetAsset(tip.assetId);
  const expiry = tip.expiresAt ? Date.parse(tip.expiresAt) : NaN;
  const steps = tipTimeline(tip);
  return (
    <div
      data-testid={`tip-detail-${tip.tipId}`}
      role="dialog"
      aria-label="Tip details"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        background: 'var(--smirk-bg-elevated, rgba(255,255,255,0.03))',
        border: '1px solid var(--smirk-border)',
        borderRadius: 'var(--smirk-radius, 8px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <AssetIcon assetId={asset.id} size={22} {...(resolveIcon ? { resolveIcon } : {})} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--smirk-font-family-mono)' }}>
            {formatAmount(tip.amount, tip.assetId, 8)} {asset.ticker}
          </div>
          <div style={{ fontSize: 11, color: 'var(--smirk-fg-muted)', overflowWrap: 'anywhere' }}>
            {tip.direction === 'sent' ? 'to' : 'from'} {tip.counterparty}
          </div>
        </div>
        <button
          onClick={onClose}
          data-testid="tip-detail-close"
          aria-label="Close"
          style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 14 }}
        >
          ✕
        </button>
      </div>

      {tip.memo && (
        <div data-testid="tip-detail-memo" style={{ fontSize: 12, fontStyle: 'italic', overflowWrap: 'anywhere' }}>
          “{tip.memo}”
        </div>
      )}

      <ol data-testid="tip-detail-timeline" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {steps.map((s) => (
          <li key={s.label} style={{ display: 'flex', gap: 8, fontSize: 12, color: STEP_COLOR[s.state] }}>
            <span aria-hidden="true">{STEP_MARK[s.state]}</span>
            <span style={{ flex: 1, color: s.state === 'todo' ? 'var(--smirk-fg-muted)' : 'inherit' }}>{s.label}</span>
            {s.detail && <span style={{ fontSize: 10, color: 'var(--smirk-fg-muted)' }}>{s.detail}</span>}
          </li>
        ))}
      </ol>

      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', fontSize: 11 }}>
        <dt style={{ color: 'var(--smirk-fg-muted)' }}>Created</dt>
        <dd style={{ margin: 0 }}>{new Date(tip.createdAt).toLocaleString()}</dd>
        {Number.isFinite(expiry) && (
          <>
            <dt style={{ color: 'var(--smirk-fg-muted)' }}>{tip.direction === 'sent' ? 'Reclaimable' : 'Claim by'}</dt>
            <dd style={{ margin: 0 }}>{new Date(expiry).toLocaleString()}</dd>
          </>
        )}
        <dt style={{ color: 'var(--smirk-fg-muted)' }}>Tip id</dt>
        <dd style={{ margin: 0, fontFamily: 'var(--smirk-font-family-mono)', overflowWrap: 'anywhere' }}>{tip.tipId}</dd>
      </dl>

      {actions && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}
