/**
 * HomeTab — top-level Home view per UI_DESIGN.md Principle 1.
 *
 * Composition:
 *   1. UnifiedBalance        — the big total + denomination + hide
 *   2. HomeActionRow         — Tip · Send · Receive · Swap
 *   3. Asset list            — one BalanceCard per registered asset
 *   4. (later) Recent activity strip
 *
 * Pure composition — no data-fetching, no formatting math, no state.
 * The consumer (extension package) wires up balances, prices, action
 * handlers, and asset filtering. This keeps `@smirk/ui` framework-
 * and platform-agnostic.
 */

import type { ComponentChildren } from 'preact';
import { BalanceCard } from './BalanceCard';
import { HomeActionRow, UnifiedBalance } from './UnifiedBalance';
import type { HomeActionRowProps, UnifiedBalanceProps } from './UnifiedBalance';

export interface HomeAssetRow {
  /** Asset id from `@smirk/assets`. */
  assetId: string;
  /** Confirmed balance in atomic units. */
  balanceAtomic: bigint | number;
  /** Optional unconfirmed balance (mempool / pending). */
  pendingAtomic?: bigint | number;
  /** Optional fiat value already formatted (e.g. `"$12.34"`). */
  fiatDisplay?: string;
  /** Loading state for this row's amount. */
  loading?: boolean;
  /** Mask the amount (renders ●●●●●). Driven by the headline's hide toggle. */
  hidden?: boolean;
}

export interface HomeTabProps {
  /** Props passed straight through to UnifiedBalance. */
  balance: UnifiedBalanceProps;
  /** Action-row handlers. */
  actions: HomeActionRowProps;
  /**
   * Asset rows in display order. Consumer decides hiding zero-balance
   * assets, sort order (by fiat value descending is typical), etc.
   */
  assets: HomeAssetRow[];
  /** Drill into asset detail when a row is tapped. */
  onAssetClick?: (assetId: string) => void;
  /** Icon resolver passed to `BalanceCard` / `AssetIcon`. */
  resolveIcon?: (iconKey: string) => string | undefined;
  /**
   * Optional slot rendered between the action row and the asset list.
   * Use for scan-progress banners, network warnings — anything the
   * user should see prominently without scrolling.
   */
  topNotice?: ComponentChildren;
  /**
   * Optional slot below the asset list — recent activity strip in
   * future, swap-in-progress banner, etc. Consumers can pass any
   * Preact node here.
   */
  footer?: ComponentChildren;
  class?: string;
}

export function HomeTab({
  balance,
  actions,
  assets,
  onAssetClick,
  resolveIcon,
  topNotice,
  footer,
  class: className,
}: HomeTabProps) {
  return (
    <div
      class={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <UnifiedBalance {...balance} />
      <HomeActionRow {...actions} />
      {topNotice}

      {assets.length === 0 ? (
        <div
          style={{
            padding: '32px 16px',
            textAlign: 'center',
            opacity: 0.6,
            fontSize: 14,
          }}
        >
          No assets configured.
        </div>
      ) : (
        <div
          class="smirk-asset-list"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {assets.map((row) => (
            <BalanceCard
              key={row.assetId}
              assetId={row.assetId}
              balanceAtomic={row.balanceAtomic}
              {...(row.pendingAtomic !== undefined ? { pendingAtomic: row.pendingAtomic } : {})}
              {...(row.fiatDisplay !== undefined ? { fiatDisplay: row.fiatDisplay } : {})}
              {...(row.loading !== undefined ? { loading: row.loading } : {})}
              {...(row.hidden !== undefined ? { hidden: row.hidden } : {})}
              {...(onAssetClick ? { onClick: () => onAssetClick(row.assetId) } : {})}
              {...(resolveIcon ? { resolveIcon } : {})}
            />
          ))}
        </div>
      )}

      {footer}
    </div>
  );
}
