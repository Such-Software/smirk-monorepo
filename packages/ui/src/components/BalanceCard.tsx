/**
 * BalanceCard — a single asset's balance, formatted from atomic units.
 *
 * Shows the icon, ticker, formatted amount, and optional fiat value. The
 * action-centric Wallet tab renders a list of these (one per registered
 * asset). Click handler is hoisted up — this component is presentational.
 */

import { mustGetAsset } from '@smirk/assets';
import { formatAmountWithAsset } from '../format';
import { AssetIcon } from './AssetIcon';

export interface BalanceCardProps {
  /** Asset id from `@smirk/assets`. */
  assetId: string;
  /** Confirmed (spendable) balance in atomic units. */
  balanceAtomic: bigint | number;
  /**
   * Optional incoming-pending balance (mempool / 0-conf). Only rendered
   * when non-zero — keeps the default row tight on pixel themes.
   */
  pendingAtomic?: bigint | number;
  /**
   * Optional on-chain-but-locked balance (CryptoNote lock window:
   * XMR ≥10 confs, WOW ≥4 confs). Only rendered when non-zero.
   * UTXO chains and Grin leave this undefined.
   */
  lockedAtomic?: bigint | number;
  /**
   * Optional in-flight outgoing total. Renders as `↑ X.XX sending`
   * in the warning color. The caller has already subtracted this
   * from `balanceAtomic` — this prop is purely for the subline.
   */
  sendingAtomic?: bigint | number;
  /** Optional fiat value (already formatted: `"$12.34"`). */
  fiatDisplay?: string;
  /** Click handler — usually a navigate to the asset's detail screen. */
  onClick?: () => void;
  /** Icon resolver (see `AssetIcon`). */
  resolveIcon?: (iconKey: string) => string | undefined;
  /** Loading state — renders shimmer placeholders for the amount. */
  loading?: boolean;
  /** Mask the amount with `●●●●●`. Pairs with the headline hide toggle. */
  hidden?: boolean;
  class?: string;
}

const HIDDEN_PLACEHOLDER = '••••';

export function BalanceCard({
  assetId,
  balanceAtomic,
  pendingAtomic,
  lockedAtomic,
  sendingAtomic,
  fiatDisplay,
  onClick,
  resolveIcon,
  loading,
  hidden,
  class: className,
}: BalanceCardProps) {
  const asset = mustGetAsset(assetId);
  // Display cap per asset: BTC keeps 8 (high $/unit, dust matters), LTC
  // 4, XMR 4, WOW 2, GRIN 2 — matches the v0.2.4 convention. Falls back
  // to full precision for any asset that hasn't opted in. AssetDetail
  // and copy/hover still surface the full atomic value.
  const displayCap = asset.displayDecimals ?? asset.decimals;
  // Balance list: trim zeros for compactness (`0.008` not `0.00800000`
  // — the latter only made sense back when we showed full precision).
  const formatted = hidden
    ? HIDDEN_PLACEHOLDER
    : formatAmountWithAsset(balanceAtomic, asset, displayCap);
  // Progressive disclosure: only render extra rows when they're non-zero.
  // Most users at most times have nothing pending/locked, so the default
  // row stays tight (one-line right column) even on pixel themes.
  const pending =
    !hidden && pendingAtomic !== undefined && pendingAtomic !== 0
      ? formatAmountWithAsset(pendingAtomic, asset, displayCap)
      : null;
  const locked =
    !hidden && lockedAtomic !== undefined && lockedAtomic !== 0
      ? formatAmountWithAsset(lockedAtomic, asset, displayCap)
      : null;
  const sending =
    !hidden && sendingAtomic !== undefined && sendingAtomic !== 0
      ? formatAmountWithAsset(sendingAtomic, asset, displayCap)
      : null;

  const Container = onClick ? 'button' : 'div';
  const hasExtras = Boolean(sending || locked || pending);

  return (
    <Container
      class={['smirk-balance-card', className].filter(Boolean).join(' ')}
      data-testid={`asset-row-${assetId}`}
      onClick={onClick}
      style={{
        // Outer is a column so the main row keeps its tight icon-
        // name-balance layout and any sublines (sending / locked /
        // pending) sit below as a full-width strip — they used to
        // stack inside the right column, which on chunky pixel
        // themes pushed wide enough to overlap the asset name.
        display: 'flex',
        flexDirection: 'column',
        padding: '6px 12px',
        width: '100%',
        background: 'transparent',
        border: 'none',
        cursor: onClick ? 'pointer' : 'default',
        textAlign: 'left',
        color: 'var(--smirk-fg)',
        fontFamily: 'inherit',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
        }}
      >
        <AssetIcon
          assetId={assetId}
          size={28}
          {...(resolveIcon ? { resolveIcon } : {})}
        />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{asset.displayName}</div>
          <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>
            {asset.ticker}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div
            data-testid={`asset-row-${assetId}-balance`}
            style={{ fontSize: 14, fontFamily: 'var(--smirk-font-family-mono, monospace)' }}
          >
            {loading ? '—' : formatted}
          </div>
          {fiatDisplay && (
            <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>{fiatDisplay}</div>
          )}
        </div>
      </div>

      {hasExtras && (
        <div
          style={{
            marginTop: 4,
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px 10px',
            justifyContent: 'flex-end',
            fontSize: 11,
            fontFamily: 'var(--smirk-font-family-mono, monospace)',
          }}
        >
          {sending && (
            <span
              style={{ color: 'var(--smirk-warning)' }}
              title="Sent — waiting for confirmation"
            >
              ↑ {sending} sending
            </span>
          )}
          {locked && (
            <span
              style={{ color: 'var(--smirk-fg-muted)' }}
              title="On-chain but inside the protocol lock window"
            >
              🔒 {locked} locked
            </span>
          )}
          {pending && (
            <span style={{ color: 'var(--smirk-warning)' }}>
              +{pending} pending
            </span>
          )}
        </div>
      )}
    </Container>
  );
}
