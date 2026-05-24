/**
 * AssetDetailScreen — per-asset drill-down landed from the Home asset row.
 *
 * Composition: BalanceCard (header) + inline-SVG sparkline strip +
 * action row + history list. Chain-shape-aware on the history rows
 * (UTXO / CryptoNote / Mimblewimble each have different field sets the
 * backend returns) but otherwise the same screen across all assets.
 *
 * Data is loaded by the shell — this component is presentational +
 * stateful only for the per-row tap (which delegates an explorer URL
 * back to the shell to open). No backend access.
 */

import { useMemo, useState } from 'preact/hooks';
import { mustGetAsset } from '@smirk/assets';
import { formatAmount } from '../format';
import { AssetIcon } from './AssetIcon';
import { BalanceCard } from './BalanceCard';

/**
 * Single transaction row, agnostic of chain. The shell normalizes
 * per-chain backend shapes into this discriminated union before
 * passing it in. Direction + amount + timestamp are required; the
 * rest is rendered as a subline when present.
 */
export type AssetDetailTxRow =
  | {
      kind: 'utxo';
      direction: 'in' | 'out';
      amountAtomic: bigint;
      txid: string;
      heightOrPending: number | 'pending';
      timestamp?: string;
      feeAtomic?: bigint;
    }
  | {
      kind: 'cryptonote';
      direction: 'in' | 'out';
      amountAtomic: bigint;
      txid: string;
      heightOrPending: number | 'pending';
      timestamp: string;
    }
  | {
      kind: 'grin';
      direction: 'in' | 'out';
      amountAtomic: bigint;
      feeAtomic: bigint;
      kernelExcess: string | null;
      slateId: string;
      status:
        | 'pending'
        | 'signed'
        | 'finalized'
        | 'confirmed'
        | 'cancelled';
      counterpartyUsername?: string;
      timestamp: string;
    }
  | {
      kind: 'tip-sent';
      tipId: string;
      amountAtomic: bigint;
      ticker: string;
      /** Recipient display string: "@bob (telegram)", "public link",
       *  etc. Shell builds this from platform + username + is_public. */
      counterparty: string;
      platform?: string;
      timestamp: string;
      /** Server-side tip status — drives the action affordance:
       *   draft / cancelled → "Discard draft" (no funds moved)
       *   pending / pending_confirmation / claiming → "↩ Clawback"
       *   claimed / clawed_back → info-only badge
       */
      status: string;
      /** Funding confirmation progress, for the "Confirming N/M" sub-line. */
      fundingConfirmations?: number;
      confirmationsRequired?: number;
      /** True iff a local IndexedDB tip-key backup exists for this
       *  tip — tagged with 🔐 so the user knows the recovery surface
       *  works even if the backend has lost the row. */
      hasLocalBackup?: boolean;
    }
  | {
      kind: 'tip-received';
      tipId: string;
      amountAtomic: bigint;
      ticker: string;
      counterparty: string;
      platform?: string;
      timestamp: string;
    };

export interface SparklinePoint {
  prices: number[];
  min: number;
  max: number;
  changePct: number;
}

export interface AssetDetailScreenProps {
  assetId: string;
  /** Confirmed (spendable) balance in atomic units. */
  balanceAtomic: bigint;
  /** Mempool / 0-conf incoming. Optional. */
  pendingAtomic?: bigint;
  /** On-chain but pre-maturity. Optional. */
  lockedAtomic?: bigint;
  /** USD fiat value as a pre-formatted string ("$12.34"). */
  fiatDisplay?: string;
  /** 2-week downsampled price series from /api/v1/prices/sparkline/:asset. */
  sparkline?: SparklinePoint;
  /** History rows newest-first. Shell merges per-chain history + tips. */
  history: AssetDetailTxRow[];
  /** Hide-balance toggle (matches the unified-balance setting). */
  hidden?: boolean;
  /** True while either history or sparkline is in-flight. */
  loading?: boolean;
  /** Tap a tx row → open the chain-appropriate explorer URL. */
  onOpenExplorer?: (row: AssetDetailTxRow) => void;
  /** Clawback an unclaimed sent tip — recovers funds to the sender.
   *  Surfaced as the per-row "↩ Clawback" button on tip-sent rows
   *  in pending / pending_confirmation / claiming status. */
  onTipClawback?: (tipId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Discard a draft sent tip — no funds moved, just cleans up the
   *  server-side draft row. Surfaced as "Discard draft" on tip-sent
   *  rows in draft status. */
  onTipDiscard?: (tipId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Called after a successful clawback/discard so the shell can
   *  refetch the history. */
  onTipActionDone?: () => void;
  /** Send action — usually navigates to the send wizard pre-filled. */
  onSend?: () => void;
  /** Receive action — navigates to the receive screen. */
  onReceive?: () => void;
  /** Tip action — opens TipMaker pre-filled with this asset. */
  onTip?: () => void;
  /** Header back button. */
  onBack: () => void;
  /** Icon resolver shared with the rest of the shell. */
  resolveIcon?: (iconKey: string) => string | undefined;
}

export function AssetDetailScreen({
  assetId,
  balanceAtomic,
  pendingAtomic,
  lockedAtomic,
  fiatDisplay,
  sparkline,
  history,
  hidden,
  loading,
  onOpenExplorer,
  onTipClawback,
  onTipDiscard,
  onTipActionDone,
  onSend,
  onReceive,
  onTip,
  onBack,
  resolveIcon,
}: AssetDetailScreenProps) {
  const asset = mustGetAsset(assetId);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        // Belt-and-suspenders against any child overflowing the popup
        // width (default box-sizing on user-agent button/div is
        // content-box, so a `width: 100%` + padding child can extend
        // beyond the popup and trigger a horizontal scrollbar at the
        // shell level).
        maxWidth: '100%',
        overflowX: 'hidden',
      }}
    >
      {/* Header: back + asset name */}
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
        <div style={{ flex: 1 }} />
        <AssetIcon
          assetId={asset.id}
          size={20}
          {...(resolveIcon ? { resolveIcon } : {})}
        />
        <strong style={{ fontSize: 13 }}>{asset.displayName}</strong>
      </div>

      {/* Balance card — re-use the Home variant so styling stays in sync */}
      <BalanceCard
        assetId={assetId}
        balanceAtomic={balanceAtomic}
        {...(pendingAtomic !== undefined ? { pendingAtomic } : {})}
        {...(lockedAtomic !== undefined ? { lockedAtomic } : {})}
        {...(fiatDisplay ? { fiatDisplay } : {})}
        {...(hidden ? { hidden } : {})}
        {...(resolveIcon ? { resolveIcon } : {})}
      />

      {/* Sparkline strip — inline SVG, no chart-lib dep. */}
      {sparkline && sparkline.prices.length > 1 && (
        <Sparkline data={sparkline} />
      )}

      {/* Action row */}
      <div style={{ display: 'flex', gap: 6 }}>
        {onSend && (
          <ActionPill onClick={onSend} icon="↗" label="Send" />
        )}
        {onReceive && (
          <ActionPill onClick={onReceive} icon="↙" label="Receive" />
        )}
        {onTip && (
          <ActionPill onClick={onTip} icon="🎁" label="Tip" />
        )}
      </div>

      {/* History */}
      <div>
        <div
          style={{
            fontSize: 10,
            color: 'var(--smirk-fg-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: 6,
          }}
        >
          Activity
        </div>
        {loading && history.length === 0 ? (
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
        ) : history.length === 0 ? (
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
            No activity yet. Sends, receives, and tips will appear here.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {history.map((row, i) => (
              <TxRow
                key={i}
                row={row}
                assetId={assetId}
                {...(hidden ? { hidden } : {})}
                {...(onOpenExplorer
                  ? { onClick: () => onOpenExplorer(row) }
                  : {})}
                {...(onTipClawback ? { onTipClawback } : {})}
                {...(onTipDiscard ? { onTipDiscard } : {})}
                {...(onTipActionDone ? { onTipActionDone } : {})}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Sparkline — inline SVG, no axes, subtle min/max + change-pct.
// ============================================================================

function Sparkline({ data }: { data: SparklinePoint }) {
  const W = 280;
  const H = 56;
  const pad = 4;

  const path = useMemo(() => {
    const { prices, min, max } = data;
    if (prices.length < 2) return '';
    const range = max - min || 1;
    const xStep = (W - pad * 2) / (prices.length - 1);
    const yFor = (p: number) =>
      H - pad - ((p - min) / range) * (H - pad * 2);
    return prices
      .map((p, i) => {
        const x = pad + i * xStep;
        const y = yFor(p);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [data]);

  const changeColor =
    data.changePct >= 0 ? 'var(--smirk-positive)' : 'var(--smirk-negative)';
  const changeSign = data.changePct >= 0 ? '+' : '';

  return (
    <div
      style={{
        background: 'var(--smirk-bg-sunken)',
        borderRadius: 'var(--smirk-radius, 8px)',
        padding: '6px 8px',
        position: 'relative',
        boxSizing: 'border-box',
        maxWidth: '100%',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 6,
          left: 8,
          fontSize: 9,
          color: 'var(--smirk-fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        2W
      </div>
      <div
        style={{
          position: 'absolute',
          top: 6,
          right: 8,
          fontSize: 11,
          color: changeColor,
          fontFamily: 'var(--smirk-font-family-mono)',
          fontWeight: 600,
        }}
      >
        {changeSign}
        {data.changePct.toFixed(2)}%
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: H, marginTop: 14, display: 'block' }}
      >
        <path
          d={path}
          stroke={changeColor}
          strokeWidth={1.5}
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

// ============================================================================
// Action pill — compact send/receive/tip button row.
// ============================================================================

function ActionPill({
  onClick,
  icon,
  label,
}: {
  onClick: () => void;
  icon: string;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        padding: '8px 4px',
        fontSize: 11,
        background: 'var(--smirk-bg-elevated)',
        border: '1px solid var(--smirk-border-strong, var(--smirk-border))',
        borderRadius: 'var(--smirk-radius, 8px)',
        color: 'inherit',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <span style={{ fontSize: 14 }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// ============================================================================
// TxRow — discriminated by row kind. Common chrome: amount + arrow + meta.
// ============================================================================

function TxRow({
  row,
  assetId,
  hidden,
  onClick,
  onTipClawback,
  onTipDiscard,
  onTipActionDone,
}: {
  row: AssetDetailTxRow;
  assetId: string;
  hidden?: boolean;
  onClick?: () => void;
  onTipClawback?: (tipId: string) => Promise<{ ok: boolean; error?: string }>;
  onTipDiscard?: (tipId: string) => Promise<{ ok: boolean; error?: string }>;
  onTipActionDone?: () => void;
}) {
  const asset = mustGetAsset(assetId);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Derive incoming + per-kind subline via a single switch so TS can
  // narrow `row.kind` cleanly. An IIFE with early returns trips TS's
  // control-flow narrowing through closure boundaries.
  let incoming: boolean;
  let meta: string;
  let isTip = false;
  switch (row.kind) {
    case 'utxo': {
      incoming = row.direction === 'in';
      const status =
        row.heightOrPending === 'pending' ? 'pending' : `#${row.heightOrPending}`;
      meta = `${status} · ${truncId(row.txid)}`;
      break;
    }
    case 'cryptonote': {
      incoming = row.direction === 'in';
      const status =
        row.heightOrPending === 'pending' ? 'pending' : `#${row.heightOrPending}`;
      meta = `${status} · ${truncId(row.txid)}`;
      break;
    }
    case 'grin': {
      incoming = row.direction === 'in';
      const idOrKernel = row.kernelExcess
        ? truncId(row.kernelExcess)
        : `slate ${truncId(row.slateId)}`;
      meta = `${row.status} · ${idOrKernel}`;
      break;
    }
    case 'tip-sent': {
      incoming = false;
      isTip = true;
      const platform = row.platform ? `${row.platform} ` : '';
      const recipientLabel = `${platform}to ${row.counterparty}`;
      meta = `${tipStatusLabel(row.status)} · ${recipientLabel}`;
      break;
    }
    case 'tip-received': {
      incoming = true;
      isTip = true;
      const platform = row.platform ? `${row.platform} ` : '';
      meta = `${platform}from ${row.counterparty}`;
      break;
    }
  }

  const amount = hidden ? '••••' : formatAmount(row.amountAtomic, assetId, 8);

  const arrowColor = incoming
    ? 'var(--smirk-positive)'
    : 'var(--smirk-fg-muted)';
  const arrow = incoming ? '↙' : '↗';

  // tip-sent rows that have an action-eligible status surface inline
  // Clawback / Discard controls. The row container becomes a non-
  // clickable `<div>` in this case (HTML forbids nesting a button
  // inside a button). The chain-explorer click affordance stays on
  // non-tip rows.
  const showTipActions =
    row.kind === 'tip-sent' &&
    ((onTipClawback &&
      (row.status === 'pending' ||
        row.status === 'pending_confirmation' ||
        row.status === 'claiming')) ||
      (onTipDiscard && row.status === 'draft'));

  const Container = !showTipActions && onClick ? 'button' : 'div';

  const handleClawback = async () => {
    if (row.kind !== 'tip-sent' || !onTipClawback) return;
    setBusy(true);
    setMsg('Clawing back…');
    const r = await onTipClawback(row.tipId);
    setBusy(false);
    setMsg(r.ok ? '✓ Clawed back' : `Error: ${r.error ?? 'unknown'}`);
    if (r.ok && onTipActionDone) onTipActionDone();
  };
  const handleDiscard = async () => {
    if (row.kind !== 'tip-sent' || !onTipDiscard) return;
    setBusy(true);
    setMsg('Discarding…');
    const r = await onTipDiscard(row.tipId);
    setBusy(false);
    setMsg(r.ok ? '✓ Discarded' : `Error: ${r.error ?? 'unknown'}`);
    if (r.ok && onTipActionDone) onTipActionDone();
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        boxSizing: 'border-box',
      }}
    >
      <Container
        {...(Container === 'button' ? { onClick } : {})}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          background: 'var(--smirk-bg-sunken)',
          border: '1px solid var(--smirk-border)',
          borderRadius: 'var(--smirk-radius, 8px)',
          color: 'inherit',
          cursor: Container === 'button' ? 'pointer' : 'default',
          fontFamily: 'inherit',
          textAlign: 'left',
          width: '100%',
          // content-box default would push padding + border BEYOND the
          // parent's 100% — triggers a horizontal scrollbar at the
          // popup shell level. border-box makes the row fit exactly.
          boxSizing: 'border-box',
        }}
      >
        <span style={{ fontSize: 16, color: arrowColor, lineHeight: 1 }}>
          {isTip ? '🎁' : arrow}
        </span>
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
            {incoming ? '+' : '−'} {amount} {asset.ticker}
            {row.kind === 'tip-sent' && row.hasLocalBackup && (
              <span
                title="Local IndexedDB backup exists — clawback works even if the backend forgets this row."
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  color: 'var(--smirk-fg-muted)',
                }}
              >
                🔐
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--smirk-fg-muted)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginTop: 1,
            }}
          >
            {meta}
          </div>
          {row.kind === 'tip-sent' &&
            row.status === 'pending_confirmation' &&
            row.confirmationsRequired !== undefined &&
            row.fundingConfirmations !== undefined &&
            row.confirmationsRequired > 0 && (
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--smirk-fg-muted)',
                  marginTop: 1,
                }}
              >
                Confirming: {row.fundingConfirmations}/
                {row.confirmationsRequired}
              </div>
            )}
        </div>
        {'timestamp' in row && row.timestamp && (
          <div
            style={{
              fontSize: 9,
              color: 'var(--smirk-fg-muted)',
              whiteSpace: 'nowrap',
            }}
          >
            {formatRelative(row.timestamp)}
          </div>
        )}
      </Container>
      {showTipActions && row.kind === 'tip-sent' && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            paddingLeft: 32,
            alignItems: 'center',
          }}
        >
          {row.status === 'draft' && onTipDiscard && (
            <button
              onClick={handleDiscard}
              disabled={busy}
              style={tipActionBtn}
            >
              Discard draft
            </button>
          )}
          {(row.status === 'pending' ||
            row.status === 'pending_confirmation' ||
            row.status === 'claiming') &&
            onTipClawback && (
              <button
                onClick={handleClawback}
                disabled={busy}
                style={tipActionBtn}
              >
                ↩ Clawback
              </button>
            )}
          {msg && (
            <span
              style={{
                fontSize: 10,
                color: msg.startsWith('Error')
                  ? 'var(--smirk-negative, #ff6b6b)'
                  : 'var(--smirk-positive)',
              }}
            >
              {msg}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const tipActionBtn = {
  fontSize: 11,
  padding: '4px 10px',
  background: 'var(--smirk-bg-elevated)',
  border: '1px solid var(--smirk-border-strong, var(--smirk-border))',
  borderRadius: 'var(--smirk-radius, 6px)',
  color: 'inherit',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

function tipStatusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'cancelled':
      return 'cancelled';
    case 'pending_confirmation':
      return 'confirming';
    case 'pending':
      return 'awaiting claim';
    case 'claiming':
      return 'claiming';
    case 'claimed':
      return 'claimed';
    case 'clawed_back':
      return 'clawed back';
    default:
      return status;
  }
}

function truncId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const dt = (Date.now() - t) / 1000;
  if (dt < 60) return 'now';
  if (dt < 3600) return `${Math.floor(dt / 60)}m`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h`;
  if (dt < 86400 * 30) return `${Math.floor(dt / 86400)}d`;
  return `${Math.floor(dt / (86400 * 30))}mo`;
}
