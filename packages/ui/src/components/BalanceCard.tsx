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
  /** Confirmed balance in atomic units. */
  balanceAtomic: bigint | number;
  /** Optional unconfirmed balance (mempool / pending). Rendered subtly. */
  pendingAtomic?: bigint | number;
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
  fiatDisplay,
  onClick,
  resolveIcon,
  loading,
  hidden,
  class: className,
}: BalanceCardProps) {
  const asset = mustGetAsset(assetId);
  // Balance list: full precision, no trim. Users want to see dust
  // (e.g., 0.00800000 LTC instead of 0.008) so they know what they
  // actually have. Matches Sparrow / Bitcoin Core convention.
  const formatted = hidden
    ? HIDDEN_PLACEHOLDER
    : formatAmountWithAsset(balanceAtomic, asset, 8, { trimZeros: false });
  const pending =
    !hidden && pendingAtomic !== undefined && pendingAtomic !== 0
      ? formatAmountWithAsset(pendingAtomic, asset, 8)
      : null;

  const Container = onClick ? 'button' : 'div';

  return (
    <Container
      class={['smirk-balance-card', className].filter(Boolean).join(' ')}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
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
        <div style={{ fontSize: 14, fontFamily: 'var(--smirk-font-family-mono, monospace)' }}>
          {loading ? '—' : formatted}
        </div>
        {fiatDisplay && (
          <div style={{ fontSize: 12, color: 'var(--smirk-fg-muted)' }}>{fiatDisplay}</div>
        )}
        {pending && (
          <div style={{ fontSize: 11, color: 'var(--smirk-warning)' }}>
            +{pending} pending
          </div>
        )}
      </div>
    </Container>
  );
}
