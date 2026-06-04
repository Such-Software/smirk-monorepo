/**
 * SentTipsScreen — list of tips the user has sent + clawback action.
 *
 * Powered by `/api/v1/tips/social/sent`. Each row shows status, asset,
 * amount, recipient, and (for clawback-eligible tips) a Clawback
 * button. Two states matter for recovery:
 *
 *   - `draft` — sender abandoned (popup closed mid-flow). No on-chain
 *     funds. "Discard" cancels the draft server-side.
 *   - `pending` / `pending_confirmation` (not claimed yet) — sender
 *     can clawback to recover funds.
 *   - `claimed` / `clawed_back` / `cancelled` — terminal, info-only.
 *
 * Component is presentational + state-light: shell provides the data,
 * delegates network calls (refresh, clawback, discard) back.
 */

import { useState } from 'preact/hooks';
import { mustGetAsset } from '@smirk/assets';
import { formatAmount } from '../format';
import { AssetIcon } from './AssetIcon';
import { Button } from './Button';

export interface SentTipRow {
  id: string;
  asset: string;
  amount: number;
  recipientPlatform: string | null;
  recipientUsername: string | null;
  isPublic: boolean;
  status: string;
  createdAt: string;
  fundingConfirmations: number;
  confirmationsRequired: number;
  /** True iff the row has a local IndexedDB tip-key backup. Lets the
   *  UI tag rows that survive even if the backend loses them. */
  hasLocalBackup?: boolean;
  /**
   * Reconstructed share URL for a public tip — only present when (a)
   * the tip is public, (b) funding has confirmed past the asset's
   * required threshold, AND (c) the local backup carries the URL
   * fragment so the shell can rebuild
   * `https://smirk.cash/tip/{id}#{fragment}`. Drives the "📋 Copy
   * link" affordance. Undefined for non-public tips, unconfirmed
   * tips, and pre-2026-06-04 backups that predate fragment
   * persistence (those tips can still be clawed back).
   */
  shareUrl?: string;
}

export interface SentTipsScreenProps {
  rows: SentTipRow[];
  loading: boolean;
  error?: string;
  onBack: () => void;
  onRefresh: () => Promise<void> | void;
  /** Clawback an unclaimed tip — recovers funds to the sender. The
   *  shell wraps `api.clawbackSocialTip(tipId)` and a per-asset
   *  sweep if needed; returns the success/error. */
  onClawback: (tipId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Cancel a draft tip — discards server-side state. No funds moved
   *  for drafts so this is just cleanup. */
  onDiscardDraft: (tipId: string) => Promise<{ ok: boolean; error?: string }>;
  resolveIcon?: (key: string) => string | undefined;
}

export function SentTipsScreen({
  rows,
  loading,
  error,
  onBack,
  onRefresh,
  onClawback,
  onDiscardDraft,
  resolveIcon,
}: SentTipsScreenProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});

  const setMsg = (id: string, msg: string) =>
    setRowMsg((m) => ({ ...m, [id]: msg }));

  const handleClawback = async (id: string) => {
    setBusyId(id);
    setMsg(id, 'Clawing back…');
    const r = await onClawback(id);
    setBusyId(null);
    setMsg(id, r.ok ? '✓ Clawed back' : `Error: ${r.error ?? 'unknown'}`);
    if (r.ok) await onRefresh();
  };

  const handleDiscard = async (id: string) => {
    setBusyId(id);
    setMsg(id, 'Discarding…');
    const r = await onDiscardDraft(id);
    setBusyId(null);
    setMsg(id, r.ok ? '✓ Discarded' : `Error: ${r.error ?? 'unknown'}`);
    if (r.ok) await onRefresh();
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxWidth: '100%',
        overflowX: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={onBack}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'inherit',
            fontFamily: 'inherit',
            fontSize: 13,
            padding: '4px 6px',
          }}
        >
          ◀ Back
        </button>
        <div style={{ flex: 1, textAlign: 'center', fontWeight: 600, fontSize: 13 }}>
          Sent Tips
        </div>
        <button
          onClick={() => void onRefresh()}
          disabled={loading}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'inherit',
            fontFamily: 'inherit',
            fontSize: 13,
            padding: '4px 6px',
          }}
        >
          ⟳
        </button>
      </div>

      {error && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--smirk-negative, #ff6b6b)',
            background: 'var(--smirk-bg-sunken)',
            padding: '8px 10px',
            borderRadius: 'var(--smirk-radius, 8px)',
            wordBreak: 'break-word',
          }}
        >
          {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div
          style={{
            fontSize: 11,
            color: 'var(--smirk-fg-muted)',
            padding: '12px 4px',
            textAlign: 'center',
          }}
        >
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div
          style={{
            fontSize: 11,
            color: 'var(--smirk-fg-muted)',
            padding: '12px 4px',
            textAlign: 'center',
            background: 'var(--smirk-bg-sunken)',
            borderRadius: 'var(--smirk-radius, 8px)',
          }}
        >
          No tips sent yet. Use the Tip button on Home to send one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((row) => (
            <TipCard
              key={row.id}
              row={row}
              busy={busyId === row.id}
              {...(rowMsg[row.id] ? { message: rowMsg[row.id] } : {})}
              onClawback={() => void handleClawback(row.id)}
              onDiscard={() => void handleDiscard(row.id)}
              {...(resolveIcon ? { resolveIcon } : {})}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// One row per tip
// ============================================================================

function TipCard({
  row,
  busy,
  message,
  onClawback,
  onDiscard,
  resolveIcon,
}: {
  row: SentTipRow;
  busy: boolean;
  message?: string;
  onClawback: () => void;
  onDiscard: () => void;
  resolveIcon?: (key: string) => string | undefined;
}) {
  const asset = mustGetAsset(row.asset);
  const amount = formatAmount(row.amount, row.asset, 8);
  const recipient = row.isPublic
    ? 'public link'
    : `@${row.recipientUsername ?? '?'}${
        row.recipientPlatform ? ` (${row.recipientPlatform})` : ''
      }`;

  const { label, color } = statusBadge(row);

  // Clawback-eligible: any state where funds are on-chain but not
  // claimed. Drafts have no on-chain funds → discard instead.
  const isDraft = row.status === 'draft';
  const isClawbackable =
    row.status === 'pending' ||
    row.status === 'pending_confirmation' ||
    row.status === 'claiming';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px',
        background: 'var(--smirk-bg-sunken)',
        border: '1px solid var(--smirk-border)',
        borderRadius: 'var(--smirk-radius, 8px)',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <AssetIcon
          assetId={asset.id}
          size={18}
          {...(resolveIcon ? { resolveIcon } : {})}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              fontFamily: 'var(--smirk-font-family-mono)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {amount} {asset.ticker} → {recipient}
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--smirk-fg-muted)',
              marginTop: 1,
            }}
          >
            {formatRelative(row.createdAt)}
            {row.hasLocalBackup && ' · 🔐 local backup'}
          </div>
        </div>
        <span
          style={{
            fontSize: 9,
            padding: '2px 6px',
            background: 'var(--smirk-bg-elevated)',
            border: `1px solid ${color}`,
            color,
            borderRadius: 'var(--smirk-radius, 6px)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            fontFamily: 'var(--smirk-font-family-mono)',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      </div>

      {row.status === 'pending_confirmation' &&
        row.confirmationsRequired > 0 && (
          <div style={{ fontSize: 10, color: 'var(--smirk-fg-muted)' }}>
            Confirming on chain: {row.fundingConfirmations}/
            {row.confirmationsRequired}
          </div>
        )}

      {/* Public-tip share affordance — only present when the shell
          successfully reconstructed the URL from the local backup's
          fragment AND funding has buried. Sits next to (not instead
          of) Clawback: the sender may still want to recover funds
          even after sharing the link. */}
      {row.shareUrl && (
        <ShareUrlPanel shareUrl={row.shareUrl} />
      )}

      {(isDraft || isClawbackable) && (
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          {isDraft && (
            <Button onClick={onDiscard} {...(busy ? { disabled: true } : {})}>
              Discard draft
            </Button>
          )}
          {isClawbackable && (
            <Button onClick={onClawback} {...(busy ? { disabled: true } : {})}>
              ↩ Clawback
            </Button>
          )}
        </div>
      )}

      {message && (
        <div
          style={{
            fontSize: 10,
            color: message.startsWith('Error')
              ? 'var(--smirk-negative, #ff6b6b)'
              : 'var(--smirk-positive)',
          }}
        >
          {message}
        </div>
      )}
    </div>
  );
}

/** Compact "ready to share" surface for a public tip. URL is rendered
 *  monospace + word-break so it's verifiable at a glance, with a
 *  one-tap Copy button. Shows a transient "Copied" affirmation so the
 *  user knows the action landed. */
function ShareUrlPanel({ shareUrl }: { shareUrl: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginTop: 4,
        padding: 8,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid var(--smirk-border)',
        borderRadius: 'var(--smirk-radius, 6px)',
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontFamily: 'var(--smirk-font-family-mono)',
          wordBreak: 'break-all',
          color: 'var(--smirk-fg-muted)',
        }}
      >
        {shareUrl}
      </div>
      <Button onClick={copy}>
        {copied ? '✓ Copied' : '⧉ Copy link'}
      </Button>
    </div>
  );
}

function statusBadge(row: SentTipRow): { label: string; color: string } {
  switch (row.status) {
    case 'draft':
      return { label: 'Draft', color: 'var(--smirk-fg-muted)' };
    case 'cancelled':
      return { label: 'Cancelled', color: 'var(--smirk-fg-muted)' };
    case 'pending_confirmation':
      return { label: 'Confirming', color: 'var(--smirk-accent)' };
    case 'pending':
      return { label: 'Pending claim', color: 'var(--smirk-accent)' };
    case 'claiming':
      return { label: 'Claiming', color: 'var(--smirk-accent)' };
    case 'claimed':
      return { label: 'Claimed', color: 'var(--smirk-positive)' };
    case 'clawed_back':
      return { label: 'Clawed back', color: 'var(--smirk-positive)' };
    default:
      return { label: row.status, color: 'var(--smirk-fg-muted)' };
  }
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const dt = (Date.now() - t) / 1000;
  if (dt < 60) return 'now';
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  if (dt < 86400 * 30) return `${Math.floor(dt / 86400)}d ago`;
  return `${Math.floor(dt / (86400 * 30))}mo ago`;
}
