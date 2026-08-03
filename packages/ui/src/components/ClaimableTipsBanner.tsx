/**
 * ClaimableTipsBanner: Home-tab affordance for tips that are ready
 * to sweep into the wallet.
 *
 * Surfaces at the top of Home (via `HomeTab.topNotice`) so users
 * notice the money waiting for them without having to navigate into
 * the Inbox. Tapping the banner routes to the Inbox tab where the
 * existing claim UI lives; we don't duplicate per-tip Claim buttons
 * here on purpose: Home is balance-glanceable, Inbox is where you do
 * work.
 *
 * Single-tip case shows the asset + amount inline ("1 BTC tip waiting"),
 * multi-tip case rolls up to a count ("3 tips waiting"). Hidden when
 * `count === 0`, so the caller doesn't need a `count > 0` guard.
 */

import type { JSX } from 'preact';
import { formatAmountWithTicker } from '../format';

export interface ClaimableTipsBannerProps {
  /** Number of tips waiting to be claimed (funding confirmed). */
  count: number;
  /**
   * For the single-tip case, the asset id + atomic amount so the
   * banner can render a specific "1 BTC waiting" instead of generic
   * "1 tip waiting". Omit when `count !== 1`.
   */
  singleTip?: { assetId: string; amountAtomic: bigint };
  /** Click handler: typically routes to the Inbox tab. */
  onView: () => void;
}

export function ClaimableTipsBanner({
  count,
  singleTip,
  onView,
}: ClaimableTipsBannerProps): JSX.Element | null {
  if (count <= 0) return null;
  const label =
    count === 1 && singleTip
      ? `${formatAmountWithTicker(singleTip.amountAtomic, singleTip.assetId)} tip ready to claim`
      : count === 1
      ? '1 tip ready to claim'
      : `${count} tips ready to claim`;
  return (
    <button
      onClick={onView}
      aria-label={label}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        background: 'var(--smirk-accent)',
        color: 'var(--smirk-accent-fg, #fff)',
        border: 'none',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left',
        width: '100%',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 16 }}>
        🎁
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      <span aria-hidden="true" style={{ opacity: 0.85, fontSize: 14 }}>
        ›
      </span>
    </button>
  );
}
