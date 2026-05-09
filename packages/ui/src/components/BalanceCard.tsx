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
  class?: string;
}

export function BalanceCard({
  assetId,
  balanceAtomic,
  pendingAtomic,
  fiatDisplay,
  onClick,
  resolveIcon,
  loading,
  class: className,
}: BalanceCardProps) {
  const asset = mustGetAsset(assetId);
  const formatted = formatAmountWithAsset(balanceAtomic, asset, 8);
  const pending =
    pendingAtomic !== undefined && pendingAtomic !== 0
      ? formatAmountWithAsset(pendingAtomic, asset, 8)
      : null;

  const Container = onClick ? 'button' : 'div';

  return (
    <Container
      class={className}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        width: '100%',
        background: 'transparent',
        border: 'none',
        cursor: onClick ? 'pointer' : 'default',
        textAlign: 'left',
        color: 'inherit',
      }}
    >
      <AssetIcon
        assetId={assetId}
        size={36}
        {...(resolveIcon ? { resolveIcon } : {})}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>{asset.displayName}</div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
          {asset.ticker}
        </div>
      </div>

      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 14, fontFamily: 'SF Mono, Monaco, monospace' }}>
          {loading ? '—' : formatted}
        </div>
        {fiatDisplay && (
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{fiatDisplay}</div>
        )}
        {pending && (
          <div style={{ fontSize: 11, color: 'rgba(255,200,0,0.8)' }}>
            +{pending} pending
          </div>
        )}
      </div>
    </Container>
  );
}
